import {
  buildQueryString,
  clearAuthCache,
  fetchWithRetry,
  getAuthCache,
  log,
  parseRetryAfterMs,
  setAuthCache,
  ToolError,
  type ToolErrorDetails,
  TRANSIENT_HTTP_STATUSES,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';
import {
  collectAuthCandidates,
  GRAPH_API_BASE,
  OUTLOOK_API_BASE,
  type OutlookAuth,
  type OutlookAuthCandidate,
} from './auth-candidates.js';
import { eligibleCandidates, listRejected, rememberRejected } from './auth-cascade-memory.js';
import { type ProbeResult, runProbe } from './diagnostics.js';
import {
  createAttemptTracker,
  isFrontDoorRefusal,
  readUpstreamRequestId,
  recodeFetchFailure,
  upstreamUnavailableError,
} from './microsoft-upstream.js';
import { tokenFingerprint } from './token-fingerprint.js';

/**
 * A request capability. Mail and calendar can require different Graph scopes, and
 * a single token is not guaranteed to carry both — enterprise tenants commonly
 * issue a narrowly-scoped Graph token alongside a broad Outlook REST token. The
 * `api()` cascade discovers the working token empirically (trying every candidate
 * on 401/403), so capability does not pre-filter candidates; it only selects an
 * independent cache slot. Separate slots stop a mail call and a calendar call from
 * evicting each other's winning token under one shared cache — which would make the
 * two endpoints repeatedly re-cascade against each other. Calendar read and write
 * are split so a mutating call never pins to a read-only token cached by a read.
 */
type Capability = 'mail' | 'calendar' | 'calendar-write';

/**
 * Every cache slot the plugin cascades in: the three request capabilities, the
 * same-origin OWS gateway (`ows`), and OneDrive uploads (`files`, Graph tokens
 * carrying Files scope only). Each slot holds one accepted token in the SDK auth
 * cache and its own set of remembered rejections in the cascade memory.
 */
export type AuthSlot = Capability | 'ows' | 'files';

export const AUTH_SLOTS: readonly AuthSlot[] = ['mail', 'calendar', 'calendar-write', 'ows', 'files'];

/** Per-slot auth cache key, keeping each token bucket separate. The same key scopes the cascade memory. */
const AUTH_CACHE_KEY: Record<AuthSlot, string> = {
  mail: 'outlook',
  calendar: 'outlook-calendar',
  'calendar-write': 'outlook-calendar-write',
  ows: 'outlook-ows',
  files: 'outlook-files',
};

export const isAuthenticated = (): boolean => {
  if (getAuthCache<OutlookAuth>(AUTH_CACHE_KEY.mail)) return true;
  return collectAuthCandidates().length > 0;
};

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------------------
// Transport — every Microsoft request goes through fetchMicrosoft
// ---------------------------------------------------------------------------

/**
 * Bound for one Graph, Outlook REST or OWS exchange, including its retries. The
 * extension ends a tool call that reports no progress after 25 s (SCRIPT_TIMEOUT_MS
 * in platform/browser-extension/src/constants.ts) and no progress is reported
 * within an exchange, so the bound sits below that budget with room for dispatch
 * overhead: the `timeout` ToolError raised here reaches the caller instead of the
 * extension's generic script timeout.
 */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Bound for one OneDrive or upload-session PUT, including its retries. This
 * exceeds the extension's 25 s no-progress budget by design: a request's bytes
 * move in a single fetch, which exposes no upload progress, so nothing can be
 * reported while one PUT is in flight. A chunked upload session reports progress
 * after every chunk (see attachLargeFileToMessage), which restarts the budget
 * between chunks up to the extension's 295 s absolute cap (MAX_SCRIPT_TIMEOUT_MS);
 * the single simple-upload PUT of a cloud attachment has no such checkpoint.
 */
const UPLOAD_TIMEOUT_MS = 120_000;
/** Attempts fetchWithRetry may make per exchange. */
const RETRY_MAX_ATTEMPTS = 3;
/**
 * Budget for the retry loop, measured from the first attempt. It matches
 * REQUEST_TIMEOUT_MS for the same reason: a retry whose backoff would end past
 * the extension's 25 s no-progress budget is not made — its result could never
 * reach the caller — and the last response is classified instead.
 */
const RETRY_DEADLINE_MS = 20_000;
/**
 * Bound for one diagnose probe. Kept well under the extension's 25 s no-progress
 * budget so a hung API base is reported as a TimeoutError probe result, rather
 * than the whole diagnose call being cut off before any probe returns.
 */
export const PROBE_TIMEOUT_MS = 10_000;

interface MicrosoftRequestOptions {
  /** Host named in log lines and error messages — never a path or query. */
  host: string;
  /**
   * Wall-clock bound for the exchange. One timeout signal is shared by every
   * attempt, so it caps the total time spent in this layer; the retry loop is
   * confined separately by RETRY_DEADLINE_MS.
   */
  timeoutMs: number;
  /** Message of the timeout ToolError when the bound is hit. */
  timeoutMessage: string;
  /**
   * Replay POST/PUT/PATCH/DELETE on a transient status or network error. Set only
   * where a replay is provably free of side effects; a front-door refusal is
   * replayed regardless, because it proves the request never reached the mailbox.
   */
  retryNonIdempotent?: boolean;
}

/**
 * Audit-log details for a ToolError classified from a Microsoft response: the
 * HTTP status and, when the upstream exposed one, its request id — never the URL.
 */
const responseErrorDetails = (response: Response): ToolErrorDetails => {
  const requestId = readUpstreamRequestId(response.headers);
  return requestId === null ? { httpStatus: response.status } : { httpStatus: response.status, requestId };
};

const rateLimitedError = (response: Response): ToolError => {
  const retryAfter = response.headers.get('Retry-After');
  return ToolError.rateLimited(
    'Microsoft API rate limit exceeded.',
    retryAfter === null ? undefined : parseRetryAfterMs(retryAfter),
  ).withDetails(responseErrorDetails(response));
};

/** True for a non-ok response fetchWithRetry gave up on: a transient status or a front-door refusal. */
const isExhaustedTransient = (response: Response): boolean =>
  !response.ok && (TRANSIENT_HTTP_STATUSES.has(response.status) || isFrontDoorRefusal(response));

/**
 * Sends one Microsoft request with transient-failure retries and classifies the
 * outcomes every transport handles alike. Resolves with the Response for every
 * status the caller must interpret itself (2xx, 401/403, 404, 400/422, ...).
 * Throws `rate_limit` for a 429 — after fetchWithRetry has honored a short
 * Retry-After (at most 10 s) on replayable requests up to RETRY_MAX_ATTEMPTS
 * within RETRY_DEADLINE_MS — with Retry-After parsed as delta-seconds or an HTTP
 * date from the final response; UPSTREAM_UNAVAILABLE for a transient status or a
 * front-door refusal that survived the retries; `timeout` when `timeoutMs`
 * elapses; NETWORK_ERROR when the connection failed on every permitted attempt;
 * and ABORTED for a caller abort.
 * Every error names the number of attempts fetchWithRetry actually made, as
 * observed through its `onRetry` callback.
 */
const fetchMicrosoft = async (url: string, init: RequestInit, options: MicrosoftRequestOptions): Promise<Response> => {
  const tracker = createAttemptTracker();

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      { ...init, signal: AbortSignal.timeout(options.timeoutMs) },
      {
        maxAttempts: RETRY_MAX_ATTEMPTS,
        deadlineMs: RETRY_DEADLINE_MS,
        retryNonIdempotent: options.retryNonIdempotent,
        isTransient: isFrontDoorRefusal,
        onRetry: tracker.onRetry,
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw ToolError.timeout(options.timeoutMessage);
    throw recodeFetchFailure(error, options.host, tracker.attempts());
  }

  if (response.status === 429) throw rateLimitedError(response);
  if (isExhaustedTransient(response)) {
    throw await upstreamUnavailableError(response, { host: options.host, attempts: tracker.attempts() });
  }
  return response;
};

// ---------------------------------------------------------------------------
// Graph / Outlook REST
// ---------------------------------------------------------------------------

/**
 * Recursively convert PascalCase keys to camelCase.
 * Outlook REST API returns PascalCase; Graph returns camelCase.
 * Normalizing to camelCase lets all mappers work with both APIs.
 */
const toCamelCase = (str: string): string => str.charAt(0).toLowerCase() + str.slice(1);

const normalizeKeys = (obj: unknown): unknown => {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(normalizeKeys);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // Skip OData metadata keys like @odata.context
    const newKey = key.startsWith('@') ? key : toCamelCase(key);
    result[newKey] = normalizeKeys(value);
  }
  return result;
};

const toPascalCase = (str: string): string => str.charAt(0).toUpperCase() + str.slice(1);

/**
 * Recursively convert object keys to PascalCase.
 * The Outlook REST API deserializes request bodies case-sensitively and requires
 * PascalCase property names for both entities (Subject, Start/DateTime) and OData
 * action parameters (Schedules, Comment). Graph uses camelCase. Request bodies are
 * authored in camelCase and transformed here when the request targets the REST base;
 * GET query options ($filter, $orderby) are case-insensitive on REST and unaffected.
 */
const pascalCaseKeys = (obj: unknown): unknown => {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(pascalCaseKeys);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[toPascalCase(key)] = pascalCaseKeys(value);
  }
  return result;
};

/** Options for one Graph / Outlook REST request. */
export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /**
   * Replay this request on a transient failure even though its method is not
   * idempotent. Only for a read expressed as a POST (an OData action such as
   * getSchedule) or a write Microsoft documents as safe to repeat.
   */
  retryNonIdempotent?: boolean;
}

/**
 * Send an authenticated request and handle the response.
 * Returns the parsed response or throws on error.
 * On 401/403, returns `null` to signal the caller to retry with a fresh token.
 */
const sendRequest = async <T>(auth: OutlookAuth, endpoint: string, options: ApiRequestOptions): Promise<T | null> => {
  const isOutlookApi = auth.apiBase === OUTLOOK_API_BASE;

  // Outlook REST API uses different $select field names, so drop $select
  // and let it return all fields. The normalizeKeys step handles casing.
  const query = options.query ? { ...options.query } : undefined;
  if (isOutlookApi && query) {
    delete (query as Record<string, unknown>).$select;
  }

  const qs = query ? buildQueryString(query) : '';
  const url = qs ? `${auth.apiBase}${endpoint}?${qs}` : `${auth.apiBase}${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    ...options.headers,
  };
  const init: RequestInit = { method: options.method ?? 'GET', headers, credentials: 'omit' };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
    const body = isOutlookApi ? pascalCaseKeys(options.body) : options.body;
    init.body = JSON.stringify(body);
  }

  const response = await fetchMicrosoft(url, init, {
    host: new URL(auth.apiBase).host,
    timeoutMs: REQUEST_TIMEOUT_MS,
    timeoutMessage: 'Microsoft API request timed out.',
    retryNonIdempotent: options.retryNonIdempotent,
  });

  if (response.status === 204) return {} as T;

  // Signal caller to retry with a fresh token
  if (response.status === 401 || response.status === 403) return null;

  if (response.status === 404) {
    throw ToolError.notFound('The requested resource was not found.').withDetails(responseErrorDetails(response));
  }

  // Reached only for statuses fetchMicrosoft does not classify: 4xx other than
  // 401/403/404/429, and the non-transient 501/505.
  if (!response.ok) {
    let errorMsg = `Microsoft API error (${response.status})`;
    try {
      const errBody = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (errBody.error?.message) {
        errorMsg = errBody.error.message;
      }
    } catch {
      // ignore parse errors
    }
    const details = responseErrorDetails(response);
    if (response.status === 400 || response.status === 422) {
      throw ToolError.validation(errorMsg).withDetails(details);
    }
    throw ToolError.internal(errorMsg).withDetails(details);
  }

  // Successful actions (cancel, RSVP, sendMail) often return 202/205 or a 200 with
  // an empty body and no JSON. Only parse when the response actually carries JSON.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return {} as T;

  const json = await response.json();
  return (isOutlookApi ? normalizeKeys(json) : json) as T;
};

// ---------------------------------------------------------------------------
// Auth cascade
// ---------------------------------------------------------------------------

/**
 * The outcome of one cascade attempt. `accepted` stops the cascade and caches the
 * token; `rejected` (the API answered 401/403) advances and remembers the
 * rejection; `skipped` (the candidate's API base cannot serve this call at all, so
 * no request was made) advances without judging the token.
 */
type CascadeAttempt<R> = { kind: 'accepted'; value: R } | { kind: 'rejected' } | { kind: 'skipped' };

/** Maps `sendRequest`'s `null`-on-401/403 contract onto a cascade outcome. */
const outcomeOf = <R>(result: R | null): CascadeAttempt<R> =>
  result === null ? { kind: 'rejected' } : { kind: 'accepted', value: result };

const logRejection = (message: string, slot: string, auth: OutlookAuth): void => {
  log.debug(message, { slot, audience: new URL(auth.apiBase).host, fingerprint: tokenFingerprint(auth.token) });
};

/**
 * The auth error a cascade ends with when no candidate accepted the call. With
 * no token on hand at all, the user is not signed in. When some candidate was
 * rejected, the session has expired. When every candidate was skipped instead,
 * the tokens on hand are valid but none can serve the call — a skip only ever
 * means the call needs Microsoft Graph and the candidate is an Outlook REST
 * token — so the message names the missing Graph token rather than blaming a
 * session that is fine.
 */
const cascadeExhaustedError = (hadCandidates: boolean, sawRejection: boolean): ToolError => {
  if (!hadCandidates) return ToolError.auth('Not authenticated — please sign in to Microsoft 365.');
  if (!sawRejection) {
    return ToolError.auth(
      'No Microsoft Graph token is available for this operation — please refresh the Outlook page.',
    );
  }
  return ToolError.auth('Authentication expired — please refresh the Outlook page.');
};

/**
 * Try `attempt` with each auth candidate for a cache slot: the cached winner first,
 * then every other MSAL candidate the slot has not already seen rejected, caching
 * whichever token the attempt accepts. This is the shared spine of every
 * authenticated transport (`api`, `owsRequest`, the attachment uploads) — each
 * differs only in how it maps a response to an outcome.
 *
 * Only a `rejected` outcome judges a token: it evicts a cached winner and is
 * remembered in the slot's cascade memory, so later calls skip the candidate until
 * every candidate is rejected, at which point the memory is cleared and the full
 * list is tried once more. A `skipped` outcome neither evicts nor remembers — a
 * cached winner skipped for one call stays the slot's winner, and a candidate
 * accepted in its place is not cached over it. An `attempt` that throws
 * (UPSTREAM_UNAVAILABLE, rate_limit, timeout, validation, not_found, ...)
 * propagates immediately and is not a rejection, which is what keeps a downstream
 * 5xx from evicting or negative-caching a working token.
 *
 * When no candidate accepts, the auth error distinguishes a cascade in which some
 * token was rejected from one in which every token was skipped (see
 * `cascadeExhaustedError`), so a valid session is never reported as expired.
 *
 * The retry budget is per transport call: at most one wrapper per cascade can
 * exhaust its retries, because exhaustion throws and ends the cascade, and a
 * rejected candidate returns on its first response.
 */
const cascadeAuth = async <R>(
  cacheKey: string,
  attempt: (auth: OutlookAuth) => Promise<CascadeAttempt<R>>,
): Promise<R> => {
  const cached = getAuthCache<OutlookAuth>(cacheKey);
  let cachedSkipped = false;
  let sawRejection = false;
  if (cached) {
    const outcome = await attempt(cached);
    // The cached token is already stored — return without re-caching it.
    if (outcome.kind === 'accepted') return outcome.value;
    if (outcome.kind === 'rejected') {
      sawRejection = true;
      clearAuthCache(cacheKey);
      rememberRejected(cacheKey, cached);
      logRejection('Cached Microsoft token rejected; re-cascading', cacheKey, cached);
    } else {
      cachedSkipped = true;
    }
  }

  const candidates = collectAuthCandidates();
  // The cached candidate was just tried — rejected or skipped, it cannot serve this call.
  const untried = cached ? candidates.filter(c => c.token !== cached.token) : candidates;
  const remaining = eligibleCandidates(cacheKey, untried);

  for (const auth of remaining) {
    const outcome = await attempt(auth);
    if (outcome.kind === 'accepted') {
      if (!cachedSkipped) setAuthCache(cacheKey, auth);
      return outcome.value;
    }
    if (outcome.kind === 'rejected') {
      sawRejection = true;
      rememberRejected(cacheKey, auth);
      logRejection('Microsoft token candidate rejected', cacheKey, auth);
    }
  }

  throw cascadeExhaustedError(cached !== null || candidates.length > 0, sawRejection);
};

/**
 * Make an authenticated request to a Microsoft 365 API for the given capability,
 * cascading through every MSAL-cached candidate on 401/403 (the capability's cached
 * winner first) and caching the first that succeeds under that capability's slot.
 * Mail requests default to the `mail` capability; calendar tools pass `calendar` or
 * `calendar-write` so their winning token is cached separately and never thrashes a
 * mail-only token. Automatically uses whichever API the resolved token supports
 * (Graph or Outlook REST). Throws an auth error only after every candidate fails.
 *
 * Transient upstream failures are retried for GET requests; a POST/PUT/PATCH/DELETE
 * is retried only when `options.retryNonIdempotent` is set or Microsoft's front door
 * refused the request before forwarding it.
 */
export const api = async <T>(
  endpoint: string,
  options: ApiRequestOptions = {},
  capability: Capability = 'mail',
): Promise<T> =>
  cascadeAuth<T>(AUTH_CACHE_KEY[capability], async auth => outcomeOf(await sendRequest<T>(auth, endpoint, options)));

// ---------------------------------------------------------------------------
// OWS gateway
// ---------------------------------------------------------------------------

// OWS gateway lives on the OWA page's own origin — a third base distinct from Graph
// and Outlook REST. It serves the client-side compose settings (roaming signatures,
// startup data) that Graph's mailboxSettings does not expose. The adapter runs on
// whichever OWA host matched (outlook.cloud.microsoft, outlook.office.com, or
// outlook.office365.com), so resolve against the current origin to stay same-origin
// rather than hardcoding one host. Read lazily (not at module scope) because the
// plugin module is also loaded in Node at build time, where `window` is undefined.
const owsBaseUrl = (): string => window.location.origin;

/** MSAL access-token claims OWS routing headers are derived from. */
interface OwsTokenClaims {
  puid?: string;
  tid?: string;
}

/**
 * Read the `puid`/`tid` claims from an MSAL access token's JWT payload. No signature
 * verification — the token is already trusted (we minted the request with it); we
 * only need its routing hints. Returns an empty object for any malformed token.
 */
const decodeTokenClaims = (jwt: string): OwsTokenClaims => {
  const payload = jwt.split('.')[1];
  if (!payload) return {};
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      puid: typeof parsed.puid === 'string' ? parsed.puid : undefined,
      tid: typeof parsed.tid === 'string' ? parsed.tid : undefined,
    };
  } catch {
    return {};
  }
};

/**
 * Build the header set OWS gateway endpoints expect. The mailbox anchor
 * (`x-anchormailbox` / `x-routingparameter-sessionkey`) is derived from the token's
 * own `puid`/`tid` claims so the gateway routes to the right mailbox's settings.
 */
const buildOwsHeaders = (token: string, extra?: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'x-ms-appname': 'owa-reactmail',
    owaappid: '00000002-0000-0ff1-ce00-000000000000',
    'x-outlook-client': 'owa',
    ...extra,
  };
  const { puid, tid } = decodeTokenClaims(token);
  if (puid) {
    const anchor = tid ? `PUID:${puid}@${tid}` : `PUID:${puid}`;
    headers['x-anchormailbox'] = anchor;
    headers['x-routingparameter-sessionkey'] = anchor;
  }
  return headers;
};

/**
 * Encode an OWS query string with `encodeURIComponent` per value, yielding `%20` for
 * spaces (in signature display names) and `%2C` for commas (the `settingname` list
 * delimiter) — both of which the OWS gateway accepts. `URLSearchParams` is avoided
 * because it encodes spaces as `+`, which OWS does not decode back to a space.
 */
const encodeOwsQuery = (query: Record<string, string | number | boolean | undefined>): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
};

export interface OwsRequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Replay this request on a transient failure even though its method is a POST — for reads issued as POST actions. */
  retryNonIdempotent?: boolean;
}

type OwsOutcome<T> = { kind: 'ok'; data: T } | { kind: 'notFound' } | { kind: 'authFail' };

/**
 * Send one OWS request with a specific token. OWS is same-origin, so cookies ride
 * along with the Bearer token, and — unlike the cross-origin Graph and REST bases,
 * whose CORS policy decides what the page may read — every response header is
 * visible here, so a front-door label or request id is always captured. A 404 means
 * the token authenticated but the settings collection holds no such item (e.g. a
 * signature with no body) — distinct from 401/403, which signals "try the next
 * candidate token".
 */
const sendOwsRequest = async <T>(
  token: string,
  endpoint: string,
  options: OwsRequestOptions,
): Promise<OwsOutcome<T>> => {
  const qs = options.query ? encodeOwsQuery(options.query) : '';
  const base = owsBaseUrl();
  const url = qs ? `${base}${endpoint}?${qs}` : `${base}${endpoint}`;

  const response = await fetchMicrosoft(
    url,
    { method: options.method ?? 'GET', headers: buildOwsHeaders(token, options.headers), credentials: 'same-origin' },
    {
      host: new URL(base).host,
      timeoutMs: REQUEST_TIMEOUT_MS,
      timeoutMessage: 'Microsoft settings request timed out.',
      retryNonIdempotent: options.retryNonIdempotent,
    },
  );

  if (response.status === 401 || response.status === 403) return { kind: 'authFail' };
  if (response.status === 404) return { kind: 'notFound' };
  if (!response.ok) {
    throw ToolError.internal(`Microsoft settings request failed (${response.status}).`).withDetails(
      responseErrorDetails(response),
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? ((await response.json()) as T) : ({} as T);
  return { kind: 'ok', data };
};

/**
 * Request an OWS gateway endpoint on the OWA origin (roaming signature settings,
 * startup data), cascading through every MSAL candidate on 401/403 exactly like
 * `api()` and caching the winner in its own slot. Returns `undefined` when a token
 * authenticated but the endpoint returned 404 (no such setting), so callers can
 * treat a missing signature as "none configured" rather than an error. Throws only
 * when no candidate authenticates at all.
 */
export const owsRequest = async <T>(endpoint: string, options: OwsRequestOptions = {}): Promise<T | undefined> =>
  cascadeAuth<T | undefined>(AUTH_CACHE_KEY.ows, async auth => {
    const outcome = await sendOwsRequest<T>(auth.token, endpoint, options);
    if (outcome.kind === 'ok') return { kind: 'accepted', value: outcome.data };
    // A 404 means this token authenticated (the gateway resolved its mailbox) and the
    // setting is simply absent — a valid winner to cache, so a genuinely-missing
    // signature does not re-cascade through every token on each subsequent call.
    if (outcome.kind === 'notFound') return { kind: 'accepted', value: undefined };
    return { kind: 'rejected' };
  });

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Graph vs Outlook REST namespaces for the fileAttachment OData type. */
const FILE_ATTACHMENT_ODATA_TYPE: Record<'graph' | 'outlook', string> = {
  graph: '#microsoft.graph.fileAttachment',
  outlook: '#Microsoft.OutlookServices.FileAttachment',
};

/** A file to embed in a message as a copy of its bytes. */
export interface FileAttachmentInput {
  /** File name including extension, e.g. "report.pdf". */
  name: string;
  /** MIME type; defaults to application/octet-stream. */
  contentType?: string;
  /** Base64-encoded file content, with no data: URI prefix. */
  contentBase64: string;
}

/**
 * Embed a file in an existing draft as a `fileAttachment`. Reuses the `mail` cache
 * slot so the attach lands on the same token — and therefore the same API base and
 * message-id namespace — that created the draft (a draft id minted on Graph is not
 * valid on Outlook REST, and vice versa). The attachment body is built per base: the
 * two APIs disagree on the OData type namespace, and `sendRequest` PascalCases the
 * property keys for the Outlook REST base while leaving Graph's camelCase untouched.
 * The POST creates an attachment, so it is never replayed on a plain 5xx.
 */
export const attachFileToMessage = async (messageId: string, attachment: FileAttachmentInput): Promise<void> =>
  cascadeAuth<void>(AUTH_CACHE_KEY.mail, async auth => {
    const namespace = auth.apiBase === GRAPH_API_BASE ? 'graph' : 'outlook';
    const body = {
      '@odata.type': FILE_ATTACHMENT_ODATA_TYPE[namespace],
      name: attachment.name,
      contentType: attachment.contentType ?? 'application/octet-stream',
      contentBytes: attachment.contentBase64,
    };
    const r = await sendRequest<unknown>(auth, `/me/messages/${messageId}/attachments`, { method: 'POST', body });
    return r === null ? { kind: 'rejected' } : { kind: 'accepted', value: undefined };
  });

/**
 * Graph vs Outlook REST namespaces and enum casing for the referenceAttachment OData
 * type. Graph spells the enums camelCase; Outlook REST spells them PascalCase. Only
 * the property keys are transformed by `sendRequest` — the string enum *values* are
 * set here per base.
 */
const REFERENCE_ATTACHMENT: Record<'graph' | 'outlook', { type: string; providerType: string; permission: string }> = {
  graph: { type: '#microsoft.graph.referenceAttachment', providerType: 'oneDriveBusiness', permission: 'view' },
  outlook: {
    type: '#Microsoft.OutlookServices.ReferenceAttachment',
    providerType: 'OneDriveBusiness',
    permission: 'View',
  },
};

/** A file already in OneDrive, attached to a message as a sharing link. */
export interface ReferenceAttachmentInput {
  /** File name including extension, e.g. "report.pdf". */
  name: string;
  /** The OneDrive sharing-link URL recipients open the file from. */
  sourceUrl: string;
}

/**
 * Attach a OneDrive file to a draft as a `referenceAttachment` (a sharing link rather
 * than an embedded copy). Reuses the `mail` cache slot for the same base/message-id
 * reasons as {@link attachFileToMessage}, and builds the body per base. The POST
 * creates an attachment, so it is never replayed on a plain 5xx.
 */
export const attachReferenceToMessage = async (
  messageId: string,
  attachment: ReferenceAttachmentInput,
): Promise<void> =>
  cascadeAuth<void>(AUTH_CACHE_KEY.mail, async auth => {
    const meta = REFERENCE_ATTACHMENT[auth.apiBase === GRAPH_API_BASE ? 'graph' : 'outlook'];
    const body = {
      '@odata.type': meta.type,
      name: attachment.name,
      sourceUrl: attachment.sourceUrl,
      providerType: meta.providerType,
      permission: meta.permission,
      isFolder: false,
    };
    const r = await sendRequest<unknown>(auth, `/me/messages/${messageId}/attachments`, { method: 'POST', body });
    return r === null ? { kind: 'rejected' } : { kind: 'accepted', value: undefined };
  });

/** The OneDrive folder cloud attachments are uploaded to, mirroring OWA's compose. */
const ONEDRIVE_ATTACHMENTS_FOLDER = 'Attachments';

const GRAPH_HOST = new URL(GRAPH_API_BASE).host;

/**
 * Upload a file to the user's OneDrive and return an organization-scoped view link for
 * it — the source URL a `referenceAttachment` points at. Cloud attachments need Drive
 * write scope, which mail tokens do not carry, so they cascade in the `files` slot and
 * skip every non-Graph candidate — Graph is the only base that can reach `/me/drive`,
 * and a skipped candidate is not a rejected one. A mail-scoped Graph token 401/403s
 * and the cascade advances; if no candidate carries Files scope, the caller sees a
 * clean auth error. A single PUT to `/content` handles files up to Graph's
 * simple-upload ceiling (250 MB), so cloud attachments carry the large files
 * embedding cannot.
 */
export const uploadAttachmentToOneDrive = async (
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<string> =>
  cascadeAuth<string>(AUTH_CACHE_KEY.files, async auth => {
    if (auth.apiBase !== GRAPH_API_BASE) return { kind: 'skipped' };
    const authHeader = { Authorization: `Bearer ${auth.token}` };
    const encodedPath = `${encodeURIComponent(ONEDRIVE_ATTACHMENTS_FOLDER)}/${encodeURIComponent(name)}`;

    // The simple-upload PUT is replayed only on a front-door refusal, which proves
    // the bytes never reached OneDrive; a plain 5xx is classified after one attempt.
    const uploadRes = await fetchMicrosoft(
      `${GRAPH_API_BASE}/me/drive/root:/${encodedPath}:/content`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': contentType },
        body: new Blob([bytes]),
        credentials: 'omit',
      },
      { host: GRAPH_HOST, timeoutMs: UPLOAD_TIMEOUT_MS, timeoutMessage: 'OneDrive upload timed out.' },
    );
    if (uploadRes.status === 401 || uploadRes.status === 403) return { kind: 'rejected' };
    if (!uploadRes.ok) {
      throw ToolError.internal(`OneDrive upload failed (${uploadRes.status}).`).withDetails(
        responseErrorDetails(uploadRes),
      );
    }
    const item = (await uploadRes.json()) as { id?: string };
    if (!item.id) throw ToolError.internal('OneDrive upload returned no item id.');

    // createLink returns the item's existing organization view link when one exists,
    // so a replayed POST has no effect beyond the first.
    const linkRes = await fetchMicrosoft(
      `${GRAPH_API_BASE}/me/drive/items/${item.id}/createLink`,
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'view', scope: 'organization' }),
        credentials: 'omit',
      },
      {
        host: GRAPH_HOST,
        timeoutMs: REQUEST_TIMEOUT_MS,
        timeoutMessage: 'OneDrive share-link creation timed out.',
        retryNonIdempotent: true,
      },
    );
    if (linkRes.status === 401 || linkRes.status === 403) return { kind: 'rejected' };
    if (!linkRes.ok) {
      throw ToolError.internal(`OneDrive share-link creation failed (${linkRes.status}).`).withDetails(
        responseErrorDetails(linkRes),
      );
    }
    const link = (await linkRes.json()) as { link?: { webUrl?: string } };
    const webUrl = link.link?.webUrl;
    if (!webUrl) throw ToolError.internal('OneDrive share-link response contained no URL.');
    return { kind: 'accepted', value: webUrl };
  });

/**
 * Upload-session chunk size. Microsoft requires every chunk but the last to be a
 * multiple of 320 KiB; this is 10 × 320 KiB (3.125 MiB), comfortably under the 4 MiB
 * per-request ceiling.
 */
const UPLOAD_SESSION_CHUNK_BYTES = 320 * 1024 * 10;

/**
 * Receives the bytes a chunked upload has committed so far, once per landed chunk.
 * Attachment tools relay it to the platform's progress channel, which restarts the
 * extension's no-progress budget between chunks.
 */
export type UploadProgressReporter = (uploadedBytes: number, totalBytes: number) => void;

/** A file whose bytes are streamed to a draft, for embeds too large to inline. */
export interface LargeFileAttachmentInput {
  /** File name including extension, e.g. "report.pdf". */
  name: string;
  /** MIME type; defaults to application/octet-stream. */
  contentType?: string;
  /** Raw file bytes. */
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Embed a file too large for a single inline request (over ~3 MB) by opening a Graph
 * attachment upload session and streaming the bytes to it in sequential chunks. The
 * session is opened on the draft's mail token/base — the same base/message-id
 * reasoning as {@link attachFileToMessage} — while the returned `uploadUrl` is
 * pre-authorized, so the chunk PUTs carry no bearer token. The final chunk's response
 * commits the attachment. Neither the session-opening POST nor a chunk PUT is replayed
 * on a plain 5xx: the session advances `nextExpectedRanges` as chunks land, so a
 * re-PUT of a chunk whose response was lost is answered with 416. `onProgress` is
 * called after each chunk is accepted, with the bytes committed so far.
 */
export const attachLargeFileToMessage = async (
  messageId: string,
  file: LargeFileAttachmentInput,
  onProgress?: UploadProgressReporter,
): Promise<void> => {
  const contentType = file.contentType ?? 'application/octet-stream';
  const total = file.bytes.byteLength;

  const session = await cascadeAuth<{ uploadUrl?: string }>(AUTH_CACHE_KEY.mail, async auth => {
    // createUploadSession exists only on Graph (Outlook REST v2.0 is decommissioned),
    // so an Outlook REST candidate is skipped — not rejected — rather than let it
    // throw and abort the cascade or be remembered as a bad mail token.
    if (auth.apiBase !== GRAPH_API_BASE) return { kind: 'skipped' };
    const body = { AttachmentItem: { attachmentType: 'file', name: file.name, size: total, contentType } };
    const r = await sendRequest<{ uploadUrl?: string }>(
      auth,
      `/me/messages/${messageId}/attachments/createUploadSession`,
      { method: 'POST', body },
    );
    return outcomeOf(r);
  });

  const uploadUrl = session.uploadUrl;
  if (!uploadUrl) throw ToolError.internal('Attachment upload session returned no upload URL.');
  // The upload URL carries a signed token in its query; only its host is ever logged.
  const uploadHost = new URL(uploadUrl).host;

  // The uploadUrl is pre-authorized; chunks must be sent in order. Content-Length is a
  // forbidden header the browser sets itself, so only Content-Range is set here.
  for (let start = 0; start < total; start += UPLOAD_SESSION_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_SESSION_CHUNK_BYTES, total);
    const chunk = file.bytes.subarray(start, end);

    const res = await fetchMicrosoft(
      uploadUrl,
      {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
        body: new Blob([chunk]),
        credentials: 'omit',
      },
      { host: uploadHost, timeoutMs: UPLOAD_TIMEOUT_MS, timeoutMessage: 'Attachment chunk upload timed out.' },
    );
    // 200 accepts an intermediate chunk; 201 commits the attachment on the final chunk.
    if (res.status !== 200 && res.status !== 201) {
      throw ToolError.internal(`Attachment chunk upload failed (${res.status}).`).withDetails(
        responseErrorDetails(res),
      );
    }
    onProgress?.(end, total);
  }
};

// ---------------------------------------------------------------------------
// Diagnostics — read-only views for the `diagnose` tool. Nothing here writes the
// auth cache or the cascade memory, and no probe goes through fetchWithRetry.
// ---------------------------------------------------------------------------

/** The token a slot currently trusts, without the secret. */
export interface CachedAuthDescriptor {
  slot: AuthSlot;
  apiBase: string;
  fingerprint: string;
  /** ISO expiry when the cached token carries MSAL provenance; null otherwise. */
  expiresAt: string | null;
}

const readCachedAuth = (slot: AuthSlot): (OutlookAuth & Partial<Pick<OutlookAuthCandidate, 'expiresOn'>>) | null =>
  getAuthCache<OutlookAuth & Partial<Pick<OutlookAuthCandidate, 'expiresOn'>>>(AUTH_CACHE_KEY[slot]);

const isoFromEpochSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString();

export const describeCachedAuth = (): CachedAuthDescriptor[] => {
  const descriptors: CachedAuthDescriptor[] = [];
  for (const slot of AUTH_SLOTS) {
    const cached = readCachedAuth(slot);
    if (!cached) continue;
    descriptors.push({
      slot,
      apiBase: cached.apiBase,
      fingerprint: tokenFingerprint(cached.token),
      expiresAt: typeof cached.expiresOn === 'number' ? isoFromEpochSeconds(cached.expiresOn) : null,
    });
  }
  return descriptors;
};

/** A candidate a slot remembers as rejected this page session, without the secret. */
export interface RejectedAuthDescriptor {
  slot: AuthSlot;
  apiBase: string;
  fingerprint: string;
  /** ISO time of the rejection. */
  rejectedAt: string;
}

export const describeRejectedAuth = (): RejectedAuthDescriptor[] =>
  AUTH_SLOTS.flatMap(slot =>
    listRejected(AUTH_CACHE_KEY[slot]).map(rejected => ({
      slot,
      apiBase: rejected.apiBase,
      fingerprint: rejected.fingerprint,
      rejectedAt: new Date(rejected.rejectedAt).toISOString(),
    })),
  );

/** The three API bases the plugin talks to. */
export type ProbeTarget = 'graph' | 'outlook-rest' | 'ows';

export const PROBE_TARGETS: readonly ProbeTarget[] = ['graph', 'outlook-rest', 'ows'];

/** A probe outcome plus the fingerprint of the token it was sent with. */
export interface ApiProbeResult extends ProbeResult {
  tokenFingerprint: string | null;
}

/** Endpoint label per target — a template, never a full URL. */
const PROBE_PATH: Record<ProbeTarget, string> = {
  graph: '/me',
  'outlook-rest': '/me',
  ows: '/ows/v1/OutlookCloudSettings/settings/',
};

/**
 * Picks the token a probe uses without touching any cache: the slot's cached
 * winner when its base matches, else the first candidate for that base. OWS accepts
 * a token of either base (see `owsRequest`), so it takes any candidate.
 */
const probeToken = (target: ProbeTarget): OutlookAuth | null => {
  if (target === 'ows') return readCachedAuth('ows') ?? collectAuthCandidates()[0] ?? null;
  const apiBase = target === 'graph' ? GRAPH_API_BASE : OUTLOOK_API_BASE;
  const cached = readCachedAuth('mail');
  if (cached?.apiBase === apiBase) return cached;
  return collectAuthCandidates().find(candidate => candidate.apiBase === apiBase) ?? null;
};

/**
 * Sends one unretried GET to `target` so the diagnosis shows the first response the
 * API gives — status, latency, request id and any front-door label — rather than the
 * third. Uses whatever token the request layer itself would pick, without caching
 * anything. With no token for the base, the probe reports that as its error.
 */
export const probeApiBase = async (target: ProbeTarget): Promise<ApiProbeResult> => {
  const auth = probeToken(target);
  const result = await runProbe(target, PROBE_PATH[target], () => {
    if (auth === null) throw new Error('No candidate token for this API base');
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    if (target === 'ows') {
      const query = encodeOwsQuery({ settingname: 'roaming_new_signature' });
      return fetch(`${owsBaseUrl()}${PROBE_PATH.ows}?${query}`, {
        headers: buildOwsHeaders(auth.token),
        credentials: 'same-origin',
        signal,
      });
    }
    const query = target === 'graph' ? `?${buildQueryString({ $select: 'id' })}` : '';
    return fetch(`${auth.apiBase}${PROBE_PATH[target]}${query}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      credentials: 'omit',
      signal,
    });
  });
  return { ...result, tokenFingerprint: auth === null ? null : tokenFingerprint(auth.token) };
};
