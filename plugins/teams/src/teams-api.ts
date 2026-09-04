import {
  fetchWithRetry,
  findLocalStorageEntry,
  getPreScriptValue,
  parseRetryAfterMs,
  ToolError,
  type ToolErrorDetails,
  TRANSIENT_HTTP_STATUSES,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type ProbeResult, runProbe } from './diagnostics.js';
import {
  createAttemptTracker,
  isFrontDoorRefusal,
  readUpstreamRequestId,
  recodeFetchFailure,
  upstreamUnavailableError,
} from './microsoft-upstream.js';
import { tokenFingerprint } from './token-fingerprint.js';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

type TeamsEnvironment = 'consumer' | 'enterprise';

/** Detect whether we are running on consumer or enterprise Teams. */
export const detectEnvironment = (): TeamsEnvironment => {
  try {
    if (typeof window !== 'undefined' && window.location.hostname === 'teams.live.com') {
      return 'consumer';
    }
  } catch {
    // Fall through to enterprise default
  }
  return 'enterprise';
};

interface EnvConfig {
  authzUrl: string;
  chatServiceBase: string | null; // null = discover from localStorage
}

const CONSUMER_CONFIG: EnvConfig = {
  authzUrl: 'https://teams.live.com/api/auth/v1.0/authz/consumer',
  chatServiceBase: 'https://teams.live.com/api/chatsvc/consumer',
};

const ENTERPRISE_CONFIG: EnvConfig = {
  get authzUrl() {
    try {
      if (typeof window !== 'undefined') {
        return `${window.location.origin}/api/authsvc/v1.0/authz`;
      }
    } catch {
      // fall through to default
    }
    return 'https://teams.microsoft.com/api/authsvc/v1.0/authz';
  },
  chatServiceBase: null, // Discovered at runtime from regionGtms
};

const getConfig = (): EnvConfig => {
  return detectEnvironment() === 'consumer' ? CONSUMER_CONFIG : ENTERPRISE_CONFIG;
};

// ---------------------------------------------------------------------------
// Skype API access token (captured by pre-script)
// ---------------------------------------------------------------------------

interface CapturedToken {
  secret: string;
  expiresOn: number;
}

/**
 * Read a value the pre-script stashed under the `teams` plugin namespace.
 *
 * `getPreScriptValue` from the SDK depends on `globalThis.__openTabs._pluginName`
 * being bound, but the adapter IIFE only binds that during tool dispatch —
 * `isReady()` runs before any tool is dispatched, so the SDK helper would
 * return `undefined` there. We try the SDK helper first (which gives
 * forward-compat with any future SDK changes), then fall back to a direct
 * namespace read against the documented path.
 */
const readPreScriptValue = <T>(key: string): T | undefined => {
  const viaSdk = getPreScriptValue<T>(key);
  if (viaSdk !== undefined) return viaSdk;
  const ns = (globalThis as { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } }).__openTabs
    ?.preScript?.teams;
  return ns?.[key] as T | undefined;
};

/** Pre-script slot holding the MSAL Skype API token for the current environment. */
const skypeAccessTokenSlot = (): 'consumerToken' | 'enterpriseToken' =>
  detectEnvironment() === 'consumer' ? 'consumerToken' : 'enterpriseToken';

/**
 * Read the MSAL-issued Skype API access token captured by the pre-script.
 * The pre-script (plugins/teams/src/pre-script.ts) observes MSAL cache
 * writes via `Storage.prototype.setItem` and an initial `localStorage`
 * scan, recognising entries by their value shape (`credentialType`,
 * `target`, `secret`, `expiresOn`). The adapter only reads the captured
 * value here — it never inspects MSAL key shapes, so the path is
 * resilient to future MSAL cache key layout changes.
 */
const getSkypeAccessToken = (): string | null => {
  const captured = readPreScriptValue<CapturedToken>(skypeAccessTokenSlot());
  if (!captured || typeof captured.secret !== 'string' || captured.secret.length === 0) {
    return null;
  }
  if (typeof captured.expiresOn !== 'number' || captured.expiresOn <= Date.now() / 1000) {
    return null;
  }
  return captured.secret;
};

// ---------------------------------------------------------------------------
// Enterprise chat service URL discovery
// ---------------------------------------------------------------------------

/** Cached enterprise chat service URL. */
let cachedEnterpriseChatServiceBase: string | null = null;

/**
 * Discover the enterprise chat service URL from the regionGtms data stored
 * in localStorage by the Teams SPA. Falls back to the AFD proxy URL.
 */
const discoverEnterpriseChatServiceBase = (): string => {
  if (cachedEnterpriseChatServiceBase) return cachedEnterpriseChatServiceBase;

  const entry = findLocalStorageEntry(key => key.includes('Discover.SKYPE-TOKEN'));
  if (entry) {
    try {
      const data = JSON.parse(entry.value) as {
        item?: { regionGtms?: { chatService?: string; chatServiceAfd?: string } };
      };
      const chatServiceAfd = data.item?.regionGtms?.chatServiceAfd;
      if (chatServiceAfd) {
        cachedEnterpriseChatServiceBase = chatServiceAfd;
        return chatServiceAfd;
      }
      const chatService = data.item?.regionGtms?.chatService;
      if (chatService) {
        cachedEnterpriseChatServiceBase = chatService;
        return chatService;
      }
    } catch {
      // Fall through to default
    }
  }

  // Default fallback — AMER region AFD proxy
  return 'https://teams.microsoft.com/api/chatsvc/amer';
};

/** Get the chat service base URL for the current environment. */
export const getChatServiceBase = (): string => {
  const config = getConfig();
  return config.chatServiceBase ?? discoverEnterpriseChatServiceBase();
};

/**
 * The enterprise chat service base discovered from localStorage and held in
 * memory; null on consumer Teams (fixed base) and before the first discovery.
 */
export const getCachedChatServiceBase = (): string | null => cachedEnterpriseChatServiceBase;

// ---------------------------------------------------------------------------
// Request layer — every Teams request goes through here
// ---------------------------------------------------------------------------

/** Attempts fetchWithRetry may make for one Teams request. */
const MAX_ATTEMPTS = 3;

/** Wall-clock timeout for a request including its retries. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Wall-clock timeout for the authsvc token exchange. */
const AUTHZ_TIMEOUT_MS = 15_000;

interface TeamsRequestOptions {
  /** Names the request in retry log lines and error messages; carries no ids. */
  label: string;
  /** Timeout for the whole request including retries (default: DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * Replay POST/PUT/PATCH/DELETE on a plain transient failure. Set only where
   * a replay is provably safe — a token exchange, a search, or the member PUT
   * that is a no-op for an existing member. A front-door refusal is replayed
   * regardless, because it proves the request never reached the service.
   */
  retryNonIdempotent?: boolean;
  /** Attempts fetchWithRetry may make (default: MAX_ATTEMPTS); probes pass 1. */
  maxAttempts?: number;
}

type TeamsRequestInit = Omit<RequestInit, 'credentials' | 'signal'> & { method: string };

/** Outcome of sendTeamsRequest: the final Response and how many requests fetchWithRetry sent to obtain it. */
interface SentTeamsRequest {
  response: Response;
  attempts: number;
}

/**
 * Sends one Teams request through fetchWithRetry with the site's timeout and
 * front-door vouching (a refusal labelled `::OnHttpRequest` never reached the
 * service, so even a POST or DELETE is replayed). Resolves with the final
 * Response for the caller to classify, plus the attempt count observed
 * through fetchWithRetry's `onRetry` callback. Throws ToolError.timeout when
 * the timeout fires, NETWORK_ERROR when every attempt failed at the network
 * layer and ABORTED when the request was aborted. Cookies are sent because
 * the authsvc and chat service endpoints are same-site with the Teams page.
 */
const sendTeamsRequest = async (
  url: string,
  init: TeamsRequestInit,
  options: TeamsRequestOptions,
): Promise<SentTeamsRequest> => {
  const host = new URL(url).host;
  const tracker = createAttemptTracker();
  try {
    const response = await fetchWithRetry(
      url,
      { ...init, credentials: 'include', signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
      {
        maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
        retryNonIdempotent: options.retryNonIdempotent ?? false,
        isTransient: isFrontDoorRefusal,
        onRetry: tracker.onRetry,
        label: options.label,
      },
    );
    return { response, attempts: tracker.attempts() };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw ToolError.timeout(`Teams request timed out: ${options.label}`);
    }
    throw recodeFetchFailure(error, host, tracker.attempts());
  }
};

/**
 * Request choke point for the Teams APIs: sends through sendTeamsRequest and
 * throws UPSTREAM_UNAVAILABLE when the final response is still a transient
 * failure (408 or a retryable 5xx), reporting the attempts actually made. A
 * 429 passes through so classifyHttpError keeps its rate-limit
 * classification, and every other status is returned for the caller to
 * classify.
 */
const teamsFetch = async (url: string, init: TeamsRequestInit, options: TeamsRequestOptions): Promise<Response> => {
  const { response, attempts } = await sendTeamsRequest(url, init, options);
  if (!response.ok && response.status !== 429 && TRANSIENT_HTTP_STATUSES.has(response.status)) {
    throw await upstreamUnavailableError(response, { host: new URL(url).host, attempts });
  }
  return response;
};

// ---------------------------------------------------------------------------
// Skype JWT exchange
// ---------------------------------------------------------------------------

/** Cached Skype JWT and its expiration time in milliseconds. */
let cachedSkypeJwt: { token: string; expiresAt: number } | null = null;

interface AuthzResponse {
  // Consumer format: { skypeToken: { skypetoken, skypeid, signinname, expiresIn } }
  skypeToken?: { skypetoken?: string; skypeid?: string; signinname?: string; expiresIn?: number };
  // Enterprise format: { tokens: { skypeToken, expiresIn } }
  tokens?: { skypeToken?: string; expiresIn?: number };
}

const noAccessTokenError = (): ToolError =>
  ToolError.auth(
    `Not authenticated — no Skype API access token captured for ${detectEnvironment()} Teams. If you just installed this plugin, reload the Teams tab so the pre-script can intercept the token.`,
  );

const authzRequestInit = (accessToken: string): TeamsRequestInit => ({
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
});

/**
 * Exchange the MSAL Skype API token for a Skype JWT at authsvc. The exchange
 * mints a fresh JWT on every call and changes nothing else, so a transient
 * failure is replayed even though the request is a POST.
 */
const exchangeSkypeToken = async (accessToken: string): Promise<AuthzResponse> => {
  const request: TeamsRequestOptions = {
    label: 'Skype JWT exchange',
    timeoutMs: AUTHZ_TIMEOUT_MS,
    retryNonIdempotent: true,
  };
  const response = await teamsFetch(getConfig().authzUrl, authzRequestInit(accessToken), request);
  return handleApiResponse<AuthzResponse>(response, request.label);
};

/**
 * The Skype JWT the adapter already holds, with at least a minute of validity
 * left, without an authsvc exchange. Two sources, in priority order:
 *
 * 1. Adapter-local cache (avoids redundant lookups within one tool invocation).
 * 2. `skypeJwt` pre-script slot — set by the authsvc fetch interceptor when
 *    Teams itself calls authsvc during startup or token refresh. This is the
 *    primary path for Teams v2, where MSAL tokens are stored encrypted and
 *    cannot be read from localStorage directly. A usable capture is promoted
 *    into the cache.
 *
 * Null when neither source holds a usable JWT.
 */
const heldSkypeJwt = (): string | null => {
  if (cachedSkypeJwt && Date.now() < cachedSkypeJwt.expiresAt - 60_000) {
    return cachedSkypeJwt.token;
  }
  const preCapture = readPreScriptValue<CapturedToken>('skypeJwt');
  if (preCapture?.secret && preCapture.expiresOn > Date.now() / 1000 + 60) {
    cachedSkypeJwt = { token: preCapture.secret, expiresAt: preCapture.expiresOn * 1000 };
    return preCapture.secret;
  }
  return null;
};

/**
 * The Skype JWT an authz response carries — enterprise returns it in
 * `tokens.skypeToken` (string), consumer in `skypeToken.skypetoken` (nested
 * object) — with its expiry; null when the response carries no token.
 */
const skypeJwtOf = (data: AuthzResponse): { token: string; expiresAt: number } | null => {
  const token = data.tokens?.skypeToken ?? data.skypeToken?.skypetoken;
  if (!token) return null;
  const expiresIn = data.tokens?.expiresIn ?? data.skypeToken?.expiresIn ?? 3600;
  return { token, expiresAt: Date.now() + expiresIn * 1000 };
};

/**
 * Get a Skype JWT for the current environment: the held JWT (see heldSkypeJwt)
 * or, on classic Teams where the pre-script captures the MSAL Skype API token
 * in plaintext from localStorage, a fresh authsvc exchange whose JWT is cached
 * for later calls. The exchange is never used on Teams v2 (the MSAL token is
 * encrypted there).
 */
const getSkypeJwt = async (): Promise<string> => {
  const held = heldSkypeJwt();
  if (held !== null) return held;

  const accessToken = getSkypeAccessToken();
  if (!accessToken) throw noAccessTokenError();

  const minted = skypeJwtOf(await exchangeSkypeToken(accessToken));
  if (minted === null) {
    throw ToolError.internal('Skype JWT exchange returned empty token');
  }
  cachedSkypeJwt = minted;
  return minted.token;
};

// ---------------------------------------------------------------------------
// Current user identity
// ---------------------------------------------------------------------------

interface SkypeIdentity {
  skypeid: string;
  signinname: string;
}

/**
 * Decode a JWT payload without verification (we only need to read claims).
 */
const decodeJwtPayload = (jwt: string): Record<string, unknown> => {
  const parts = jwt.split('.');
  if (parts.length < 2) return {};
  try {
    // base64url payloads are emitted without `=` padding; restore it before
    // calling atob, which throws InvalidCharacterError on lengths not
    // divisible by 4.
    const raw = parts[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '';
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Read the sign-in email captured by the pre-script. The pre-script
 * decodes the MSAL ID token's JWT and stashes
 * `preferred_username` / `upn` / `email` under `signInName`.
 * Enterprise authz responses do not include the email, so we depend on
 * the ID token claims for it.
 */
const findSignInName = (): string => readPreScriptValue<string>('signInName') ?? '';

/**
 * Get the current user's Skype identity (MRI and sign-in email) by performing
 * a Skype JWT exchange and reading the identity fields from the response.
 * On enterprise, identity is extracted from the JWT payload and MSAL ID token.
 */
export const getSkypeIdentity = async (): Promise<SkypeIdentity> => {
  const accessToken = getSkypeAccessToken();
  if (!accessToken) throw noAccessTokenError();

  const data = await exchangeSkypeToken(accessToken);

  // Consumer returns identity directly in the response
  if (data.skypeToken?.skypeid) {
    return {
      skypeid: data.skypeToken.skypeid,
      signinname: data.skypeToken.signinname ?? '',
    };
  }

  // Enterprise: decode the JWT to get skypeid, and read email from MSAL ID token
  const jwt = data.tokens?.skypeToken ?? data.skypeToken?.skypetoken ?? '';
  const claims = jwt ? decodeJwtPayload(jwt) : {};
  return {
    skypeid: String(claims.skypeid ?? ''),
    signinname: findSignInName(),
  };
};

// ---------------------------------------------------------------------------
// Authentication detection
// ---------------------------------------------------------------------------

/**
 * Check if a Loki token (Teams v2 readiness signal) is present and valid.
 * The Loki token indicates the user is logged into Teams v2 but cannot be
 * used for Skype API calls — the actual Skype JWT is captured separately
 * via the authsvc fetch interceptor.
 */
const hasValidLokiToken = (): boolean => {
  const token = readPreScriptValue<CapturedToken>('lokiToken');
  return !!(token?.secret && token.expiresOn > Date.now() / 1000);
};

export const isTeamsAuthenticated = (): boolean =>
  // Classic Teams: MSAL Skype API token captured from localStorage.
  getSkypeAccessToken() !== null ||
  // Teams v2: Loki token present (user is logged in; Skype JWT captured separately).
  hasValidLokiToken();

/**
 * Wait for the pre-script to capture an auth signal. On classic Teams the MSAL
 * Skype token is captured at document_start; on Teams v2 the Loki token lands
 * as Teams writes it to sessionStorage during startup. Polls at 500ms intervals
 * for up to 8 seconds.
 */
export const waitForTeamsAuth = (): Promise<boolean> =>
  waitUntil(() => isTeamsAuthenticated(), { interval: 500, timeout: 8000 }).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------------------
// Chat Service API
// ---------------------------------------------------------------------------

const skypeTokenHeaders = (skypeJwt: string): Record<string, string> => ({
  Authentication: `skypetoken=${skypeJwt}`,
  'Content-Type': 'application/json',
});

const appendQuery = (url: string, query: Record<string, string | number | boolean | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
};

/**
 * Make an authenticated request to the Teams Chat Service (Skype-based API).
 * Uses the Skype JWT obtained via MSAL token exchange.
 * Automatically routes to the correct endpoint for consumer or enterprise.
 *
 * GET requests are replayed on transient failures; POST, PUT and DELETE only
 * when the front door vouches the request never reached the service, or when
 * `retryNonIdempotent` is set — a replayed send would post twice.
 */
export const chatApi = async <T>(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    query?: Record<string, string | number | boolean | undefined>;
    retryNonIdempotent?: boolean;
  } = {},
): Promise<T> => {
  const skypeJwt = await getSkypeJwt();
  const { method = 'GET', body, query, retryNonIdempotent } = options;
  const url = appendQuery(`${getChatServiceBase()}${endpoint}`, query ?? {});
  const request: TeamsRequestOptions = { label: `Teams Chat API ${method}`, retryNonIdempotent };

  const response = await teamsFetch(
    url,
    { method, headers: skypeTokenHeaders(skypeJwt), body: body ? JSON.stringify(body) : undefined },
    request,
  );

  return handleApiResponse<T>(response, request.label);
};

/**
 * Create a chat thread via the Chat Service. Returns the thread ID extracted
 * from the Location response header. Never replayed: a second POST would
 * create a duplicate thread.
 */
export const createThread = async (
  members: Array<{ id: string; role: string }>,
  properties?: Record<string, unknown>,
): Promise<string> => {
  const skypeJwt = await getSkypeJwt();

  const body: Record<string, unknown> = { members };
  if (properties) body.properties = properties;

  const request: TeamsRequestOptions = { label: 'Teams create thread' };
  const response = await teamsFetch(
    `${getChatServiceBase()}/v1/threads`,
    { method: 'POST', headers: skypeTokenHeaders(skypeJwt), body: JSON.stringify(body) },
    request,
  );

  if (!response.ok) await classifyHttpError(response, request.label);

  const location = response.headers.get('Location') ?? '';
  const threadId = location.split('/threads/').pop() ?? '';
  if (!threadId) {
    throw ToolError.internal('Thread created but no thread ID returned in Location header');
  }
  return threadId;
};

/**
 * Make an authenticated request to a thread-level endpoint
 * (`/v1/threads/{threadId}/...`). Used for member management and
 * property updates on existing threads.
 *
 * GET requests are replayed on transient failures; PUT and DELETE only when
 * the front door vouches the request never reached the service, or when the
 * caller sets `retryNonIdempotent` — right for the member PUT, which is a
 * no-op for an existing member; wrong for a DELETE, and for the topic PUT,
 * whose replay after a hidden success would post a second topic-change event.
 */
export const threadApi = async <T>(
  threadId: string,
  subpath: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    retryNonIdempotent?: boolean;
  } = {},
): Promise<T> => {
  const skypeJwt = await getSkypeJwt();
  const { method = 'GET', body, retryNonIdempotent } = options;
  const url = `${getChatServiceBase()}/v1/threads/${encodeURIComponent(threadId)}${subpath}`;
  const request: TeamsRequestOptions = { label: `Teams thread API ${method}`, retryNonIdempotent };

  const response = await teamsFetch(
    url,
    { method, headers: skypeTokenHeaders(skypeJwt), body: body ? JSON.stringify(body) : undefined },
    request,
  );

  return handleApiResponse<T>(response, request.label);
};

// ---------------------------------------------------------------------------
// Substrate Search API
// ---------------------------------------------------------------------------

const SUBSTRATE_SEARCH_URL = 'https://substrate.office.com/searchservice/api/v2/query';

/** Path label for the Substrate search endpoint in probe results and error messages. */
const SUBSTRATE_SEARCH_PATH = '/searchservice/api/v2/query';

/**
 * `$select`-equivalent extension fields requested for each message hit. These
 * surface the Teams-specific properties (thread type, sender identity) that
 * are not part of the base Substrate message schema.
 */
const SEARCH_MESSAGE_EXTENSION_FIELDS = [
  'Extension_SkypeSpaces_ConversationPost_Extension_ThreadType_String',
  'Extension_SkypeSpaces_ConversationPost_Extension_FromSkypeInternalId_String',
  'Extension_SkypeSpaces_ConversationPost_Extension_SkypeGroupId_String',
];

export interface MessageSearchRequest {
  /** Keyword/KQL query string. */
  query: string;
  /** Number of results to skip. */
  from: number;
  /** Number of results to return. */
  size: number;
}

/**
 * Build the Substrate Search request body Teams' own search bar sends for a
 * message query. Shared by search_messages and the diagnose Substrate probe so
 * the probe exercises the real wire shape.
 */
export const buildMessageSearchBody = ({ query, from, size }: MessageSearchRequest): Record<string, unknown> => ({
  entityRequests: [
    {
      entityType: 'Message',
      contentSources: ['Teams'],
      fields: SEARCH_MESSAGE_EXTENSION_FIELDS,
      propertySet: 'Optimized',
      query: { queryString: query, displayQueryString: query },
      from,
      size,
      topResultsCount: 0,
    },
  ],
  cvid: crypto.randomUUID(),
  logicalId: crypto.randomUUID(),
  scenario: {
    Dimensions: [
      { DimensionName: 'QueryType', DimensionValue: 'Messages' },
      { DimensionName: 'FormFactor', DimensionValue: 'general.web.reactSearch' },
    ],
    Name: 'powerbar',
  },
});

/**
 * Read the Substrate Search access token captured by the pre-script.
 * Unlike the Skype token, this one is used directly as a `Bearer` against
 * the Substrate Search API — no authz exchange.
 */
const getSubstrateToken = (): string | null => {
  const captured = readPreScriptValue<CapturedToken>('substrateToken');
  if (!captured || typeof captured.secret !== 'string' || captured.secret.length === 0) {
    return null;
  }
  if (typeof captured.expiresOn !== 'number' || captured.expiresOn <= Date.now() / 1000) {
    return null;
  }
  return captured.secret;
};

const noSubstrateTokenError = (): ToolError =>
  ToolError.auth(
    'Not authenticated for search — no Substrate Search token captured. Reload the Teams tab so the pre-script can intercept it. Search requires enterprise Teams (teams.microsoft.com).',
  );

/**
 * Build Substrate routing headers from the token's own claims. Substrate
 * fans a query out across mailboxes/regions and uses `X-AnchorMailbox` /
 * `X-RoutingParameter-SessionKey` to land the request on the user's mailbox.
 * The `puid`, `oid`, and `tid` claims in the access token are the
 * authoritative source for those values.
 */
const buildSubstrateRoutingHeaders = (token: string): Record<string, string> => {
  const claims = decodeJwtPayload(token);
  const tid = String(claims.tid ?? '');
  const puid = String(claims.puid ?? '');
  const oid = String(claims.oid ?? '');
  const headers: Record<string, string> = {};
  if (puid && tid) headers['X-AnchorMailbox'] = `PUID:${puid}@${tid}`;
  if (oid && tid) headers['X-RoutingParameter-SessionKey'] = `OID:${oid}@${tid}`;
  return headers;
};

const substrateRequestInit = (token: string, body: Record<string, unknown>): TeamsRequestInit => ({
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...buildSubstrateRoutingHeaders(token),
  },
  body: JSON.stringify(body),
});

/**
 * Query the Microsoft Substrate Search API. Powers Teams' universal search
 * across messages, files, people, and chats. Authenticated with the raw
 * Substrate access token as a `Bearer`. A search is a pure read, so the POST
 * is replayed on transient failures.
 */
export const substrateSearch = async <T>(body: Record<string, unknown>): Promise<T> => {
  const token = getSubstrateToken();
  if (!token) throw noSubstrateTokenError();

  const request: TeamsRequestOptions = { label: 'Teams search', retryNonIdempotent: true };
  const response = await teamsFetch(SUBSTRATE_SEARCH_URL, substrateRequestInit(token, body), request);

  return handleApiResponse<T>(response, request.label);
};

// ---------------------------------------------------------------------------
// Shared response handling
// ---------------------------------------------------------------------------

/** Parses a successful response as JSON; `label` names the request in errors and carries no ids. */
const handleApiResponse = async <T>(response: Response, label: string): Promise<T> => {
  if (!response.ok) await classifyHttpError(response, label);

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {} as T;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw ToolError.internal(`Teams API returned invalid JSON: ${label}`);
  }

  return data as T;
};

/** Clear all module-level caches so the next API call re-discovers fresh values. */
export const clearCaches = (): void => {
  cachedEnterpriseChatServiceBase = null;
  cachedSkypeJwt = null;
};

interface TeamsErrorEnvelope {
  code: string | null;
  message: string | null;
}

/** An envelope field: a non-empty string, or a number rendered as text; null for anything else. */
const envelopeFieldSchema = z
  .union([z.string().min(1), z.number().transform(String)])
  .nullable()
  .catch(null);

/** The fields a Teams error object names: its code is `code` or `errorCode`, its message `message`. */
const teamsErrorObjectSchema = z.object({
  code: envelopeFieldSchema,
  errorCode: envelopeFieldSchema,
  message: envelopeFieldSchema,
});

/** A Teams error body: the error object sits under `error` when that is an object, at the top level otherwise. */
const teamsErrorBodySchema = z.union([
  z.object({ error: teamsErrorObjectSchema }).transform(body => body.error),
  teamsErrorObjectSchema,
]);

/**
 * Reads the JSON error envelope of a failed Teams response. Null when the body
 * is not JSON, does not parse, is not an object, or names neither a code nor
 * a message. The raw body is never quoted: chat service bodies echo the
 * thread or message id of the failed request.
 */
const readTeamsErrorEnvelope = async (response: Response): Promise<TeamsErrorEnvelope | null> => {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  const body = teamsErrorBodySchema.safeParse(parsed);
  if (!body.success) return null;
  const code = body.data.code ?? body.data.errorCode;
  const message = body.data.message;
  return code === null && message === null ? null : { code, message };
};

/** Longest upstream error message quoted inside a classified 4xx message. */
const MAX_ENVELOPE_MESSAGE_CHARS = 200;

/**
 * Caps a quoted envelope message at MAX_ENVELOPE_MESSAGE_CHARS with a trailing
 * ellipsis. Mirrors the unexported `truncate` of ./microsoft-upstream.ts, which
 * applies the same cap to the envelope quoted in UPSTREAM_UNAVAILABLE messages.
 */
const truncateEnvelopeMessage = (text: string): string =>
  text.length > MAX_ENVELOPE_MESSAGE_CHARS ? `${text.slice(0, MAX_ENVELOPE_MESSAGE_CHARS - 1)}…` : text;

/** ` — <code>: <message>` for a present envelope, empty otherwise. */
const envelopeText = (envelope: TeamsErrorEnvelope | null): string => {
  if (envelope === null) return '';
  const parts = [envelope.code, envelope.message === null ? null : truncateEnvelopeMessage(envelope.message)];
  return ` — ${parts.filter(part => part !== null).join(': ')}`;
};

/**
 * The audit-log facts of a classified failure: the HTTP status and, when the
 * upstream exposed one, its request id — never the endpoint.
 */
const responseErrorDetails = (response: Response): ToolErrorDetails => {
  const requestId = readUpstreamRequestId(response.headers);
  return requestId === null ? { httpStatus: response.status } : { httpStatus: response.status, requestId };
};

/**
 * Classify non-transient HTTP errors into ToolError categories. Always throws.
 * Transient statuses never reach here — teamsFetch throws UPSTREAM_UNAVAILABLE
 * for them first — except 429, which keeps its rate-limit classification.
 * Messages name the request by its label (never the endpoint, which carries
 * thread and message ids), quote the JSON error envelope when there is one,
 * and end with the upstream request id so a failure can be matched against
 * Microsoft's service logs. Every error carries responseErrorDetails.
 */
const classifyHttpError = async (response: Response, label: string): Promise<never> => {
  const { status, headers } = response;
  const detail = envelopeText(await readTeamsErrorEnvelope(response));
  const details = responseErrorDetails(response);
  const requestId = ` (request-id ${readUpstreamRequestId(headers) ?? 'unavailable'})`;

  if (status === 429) {
    const retryAfterHeader = headers.get('Retry-After');
    const retryMs = retryAfterHeader !== null ? parseRetryAfterMs(retryAfterHeader) : undefined;
    throw ToolError.rateLimited(`Teams API rate limited: ${label}${detail}${requestId}`, retryMs).withDetails(details);
  }
  if (status === 401 || status === 403) {
    cachedSkypeJwt = null;
    throw ToolError.auth(`Teams API auth error (${String(status)}): ${label}${detail}${requestId}`).withDetails(
      details,
    );
  }
  if (status === 404) {
    throw ToolError.notFound(`Teams API not found: ${label}${detail}${requestId}`).withDetails(details);
  }
  if (status === 400) {
    throw ToolError.validation(`Teams API bad request: ${label}${detail}${requestId}`).withDetails(details);
  }
  throw ToolError.internal(`Teams API error (${String(status)}): ${label}${detail}${requestId}`).withDetails(details);
};

// ---------------------------------------------------------------------------
// Diagnostics — token inventory and single-attempt probes for `diagnose`
// ---------------------------------------------------------------------------

/**
 * Where the adapter can find an auth credential, in the order the request
 * layer consults them. `signInName` is the user's e-mail rather than a token
 * and is reported as present/absent only.
 */
export const TEAMS_TOKEN_SOURCES = [
  'msalSkypeToken',
  'lokiToken',
  'skypeJwtPreScript',
  'skypeJwtCache',
  'substrateToken',
  'signInName',
] as const;

export type TeamsTokenSourceName = (typeof TEAMS_TOKEN_SOURCES)[number];

export interface TeamsTokenSource {
  source: TeamsTokenSourceName;
  /** Whether a value is currently held for this source. */
  present: boolean;
  /** Seconds until the credential expires (negative once expired); null when unknown or not a token. */
  expiresInSec: number | null;
  /** Host of the token's `aud` claim, or the claim itself when it is an application id; null when absent. */
  audienceHost: string | null;
  /** Last four hex digits of an FNV-1a hash of the secret — distinguishes tokens without revealing them. */
  fingerprint: string | null;
}

/** Last four hex digits of the 32-bit FNV-1a hash of `secret`. */
/** Host of a JWT's `aud` claim when it is a URL, the claim itself otherwise (application-id audiences), null when absent. */
const audienceHostOf = (jwt: string): string | null => {
  const aud = decodeJwtPayload(jwt).aud;
  const audience = Array.isArray(aud) ? aud[0] : aud;
  if (typeof audience !== 'string' || audience === '') return null;
  try {
    return new URL(audience).host;
  } catch {
    return audience;
  }
};

const absentTokenSource = (source: TeamsTokenSourceName): TeamsTokenSource => ({
  source,
  present: false,
  expiresInSec: null,
  audienceHost: null,
  fingerprint: null,
});

const describeSecret = (source: TeamsTokenSourceName, secret: string, expiresAtMs: number): TeamsTokenSource => ({
  source,
  present: true,
  expiresInSec: Math.round((expiresAtMs - Date.now()) / 1000),
  audienceHost: audienceHostOf(secret),
  fingerprint: tokenFingerprint(secret),
});

const describeCapturedToken = (source: TeamsTokenSourceName, slot: string): TeamsTokenSource => {
  const captured = readPreScriptValue<CapturedToken>(slot);
  if (
    !captured ||
    typeof captured.secret !== 'string' ||
    captured.secret === '' ||
    typeof captured.expiresOn !== 'number'
  ) {
    return absentTokenSource(source);
  }
  return describeSecret(source, captured.secret, captured.expiresOn * 1000);
};

/**
 * Presence, expiry, audience and fingerprint of every credential source the
 * adapter reads. Never returns a secret: the fingerprint is a four-hex-digit
 * hash, and the sign-in name (PII) is reported as present or absent only.
 */
export const describeTokenSources = (): TeamsTokenSource[] => [
  describeCapturedToken('msalSkypeToken', skypeAccessTokenSlot()),
  describeCapturedToken('lokiToken', 'lokiToken'),
  describeCapturedToken('skypeJwtPreScript', 'skypeJwt'),
  cachedSkypeJwt
    ? describeSecret('skypeJwtCache', cachedSkypeJwt.token, cachedSkypeJwt.expiresAt)
    : absentTokenSource('skypeJwtCache'),
  describeCapturedToken('substrateToken', 'substrateToken'),
  { ...absentTokenSource('signInName'), present: findSignInName() !== '' },
];

/** Sends one probe request — a single attempt, so runProbe sees raw upstream behavior — and resolves with its Response. */
const sendProbeRequest = async (
  url: string,
  init: TeamsRequestInit,
  label: string,
  timeoutMs?: number,
): Promise<Response> => {
  const { response } = await sendTeamsRequest(url, init, {
    label,
    maxAttempts: 1,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  return response;
};

/**
 * Caches the Skype JWT a successful authsvc probe minted so the chat-service
 * probe can send it instead of exchanging again. A 2xx body that is not JSON
 * or carries no token leaves the cache untouched: the probe still reports the
 * status it saw, and the chat-service probe reports the missing JWT.
 */
const cacheProbedSkypeJwt = async (response: Response): Promise<void> => {
  let data: AuthzResponse;
  try {
    data = (await response.json()) as AuthzResponse;
  } catch {
    return;
  }
  const minted = skypeJwtOf(data);
  if (minted !== null) cachedSkypeJwt = minted;
};

/**
 * Single-attempt POST to the authsvc token exchange with the captured MSAL
 * Skype token. Reports the missing token as the probe error on Teams v2,
 * where the MSAL cache is encrypted and the exchange is never used. The JWT a
 * successful exchange mints is cached for the chat-service probe, so diagnose
 * exchanges at most once.
 */
export const probeAuthz = (): Promise<ProbeResult> => {
  const authzUrl = getConfig().authzUrl;
  return runProbe('authsvc', new URL(authzUrl).pathname, async () => {
    const accessToken = getSkypeAccessToken();
    if (!accessToken) throw noAccessTokenError();
    const response = await sendProbeRequest(authzUrl, authzRequestInit(accessToken), 'authsvc probe', AUTHZ_TIMEOUT_MS);
    if (response.ok) await cacheProbedSkypeJwt(response.clone());
    return response;
  });
};

/** Endpoint label of the chat-service probe; also the path it requests. */
const CONVERSATIONS_PATH = '/v1/users/ME/conversations';

/**
 * The error a chat-service probe records when no Skype JWT is held. The
 * authsvc probe is the only exchange diagnose performs, so its outcome
 * explains the missing credential: the error it recorded when it made no
 * request or threw, otherwise the status it received without a usable JWT.
 * The prefix marks the failure as the credential step's — it is otherwise
 * indistinguishable from a chat service failure.
 */
const skypeJwtUnavailableError = (authsvc: ProbeResult): ToolError =>
  ToolError.auth(
    `Skype JWT unavailable: ${authsvc.error ?? `the authsvc probe received HTTP ${String(authsvc.status)} without a Skype JWT`}`,
  );

/**
 * Single-attempt GET of the user's conversation list (one page of one) against
 * the chat service, sent with the Skype JWT already held — the one the authsvc
 * probe minted, the cached one, or the pre-script capture — so the probe never
 * triggers an exchange of its own. `authsvc` is the outcome of the authsvc
 * probe, which must have settled first; when no JWT is held, the probe reports
 * that outcome as its error without a request.
 */
export const probeChatService = (authsvc: ProbeResult): Promise<ProbeResult> => {
  const skypeJwt = heldSkypeJwt();
  return runProbe('chatsvc', CONVERSATIONS_PATH, async () => {
    if (skypeJwt === null) throw skypeJwtUnavailableError(authsvc);
    const url = appendQuery(`${getChatServiceBase()}${CONVERSATIONS_PATH}`, {
      view: 'superchat',
      pageSize: 1,
      startTime: 0,
      targetType: 'Thread|Passport',
    });
    return sendProbeRequest(url, { method: 'GET', headers: skypeTokenHeaders(skypeJwt) }, 'chatsvc probe');
  });
};

/** Single-attempt one-result message search against Substrate; reports the missing token as the probe error. */
export const probeSubstrate = (): Promise<ProbeResult> =>
  runProbe('substrate', SUBSTRATE_SEARCH_PATH, async () => {
    const token = getSubstrateToken();
    if (!token) throw noSubstrateTokenError();
    const body = buildMessageSearchBody({ query: '*', from: 0, size: 1 });
    return sendProbeRequest(SUBSTRATE_SEARCH_URL, substrateRequestInit(token, body), 'substrate probe');
  });
