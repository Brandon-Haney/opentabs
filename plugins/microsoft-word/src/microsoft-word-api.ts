import {
  buildQueryString,
  clearAuthCache,
  fetchWithRetry,
  findLocalStorageEntry,
  getCurrentUrl,
  getLocalStorage,
  getPreScriptValue,
  parseRetryAfterMs,
  ToolError,
  type ToolErrorDetails,
  TRANSIENT_HTTP_STATUSES,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';
import { type ProbeResult, runProbe } from './diagnostics.js';
import {
  createAttemptTracker,
  isFrontDoorRefusal,
  readUpstreamRequestId,
  recodeFetchFailure,
  upstreamUnavailableError,
} from './microsoft-upstream.js';
import { parseReloadMarker, type ReloadMarker } from './reload-marker-parse.js';
import { tokenFingerprint } from './token-fingerprint.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_API_BASE = `${GRAPH_ORIGIN}/v1.0`;
/** Host named in upstream error messages and retry log lines — never a path. */
const GRAPH_HOST = 'graph.microsoft.com';
/** Hostname of the standalone Word web app. */
const CLOUD_APP_HOSTNAME = 'word.cloud.microsoft';

/** Overall budget for one Graph or download request including its retries. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Budget for a single diagnostic probe. */
const PROBE_TIMEOUT_MS = 15_000;
/**
 * Budget for the item-metadata GET that precedes a download, including the
 * retries `api` makes inside it. It is deliberately half the default request
 * budget: the GET is a small JSON read whose transient failures are already
 * retried, so a response still outstanding at 15 s is a hung request, and
 * the tools built on it chain this call with a download, a rebuild and a
 * content PUT without reporting progress — all of which must finish inside
 * the extension's 25 s no-progress budget.
 */
export const METADATA_TIMEOUT_MS = 15_000;
/** Attempts fetchWithRetry may make per request. */
const MAX_ATTEMPTS = 3;

// Microsoft 365 consumer app MSAL client ID
const MSAL_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';
/** localStorage key the pre-script mirrors the captured Graph token to. */
const LS_TOKEN_KEY = '__opentabs_word_graph_token';
/** Pre-script namespace key holding the captured Graph token. */
const PRE_SCRIPT_TOKEN_KEY = 'graph';
/** Pre-script namespace key holding the epoch-ms time the token was captured. */
const PRE_SCRIPT_CAPTURED_AT_KEY = 'graphCapturedAt';
/** Pre-script namespace key holding the Office reload marker captured at document_start. */
const PRE_SCRIPT_RELOAD_MARKER_KEY = 'reloadMarker';
/** A token this close to expiry is not handed to a request. */
const TOKEN_EXPIRY_MARGIN_SEC = 30;

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

/**
 * Where a Graph token can come from, in the order `getToken` consults them:
 * the pre-script's in-page namespace, the localStorage mirror the pre-script
 * writes for warm reloads, and the standalone app's plaintext MSAL cache.
 */
export const GRAPH_TOKEN_SOURCES = ['preScript', 'localStorageMirror', 'msalPlaintext'] as const;
export type GraphTokenSource = (typeof GRAPH_TOKEN_SOURCES)[number];

/** Diagnostic description of one token source. Never carries the token itself. */
export interface TokenSourceReport {
  source: GraphTokenSource;
  /** Whether the source holds a token, live or expired. */
  present: boolean;
  /** Seconds until the token expires (negative once expired); null when absent. */
  expiresInSec: number | null;
  /** Host of the token's `aud` claim, or the raw claim when it is not a URL; null when absent or undecodable. */
  audience: string | null;
  /** Short non-secret identifier for the token, from `tokenFingerprint`; null when absent. */
  fingerprint: string | null;
  /** Seconds since the pre-script captured the token; only the preScript source reports it. */
  capturedAgoSec: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Read a value the pre-script stashed under the `microsoft-word` namespace.
 *
 * `getPreScriptValue` depends on `globalThis.__openTabs._pluginName`, which the
 * adapter only binds during tool dispatch — so it returns `undefined` in
 * `isReady()` and `onActivate()`, which run earlier. We try the SDK helper first
 * (forward-compat), then fall back to a direct read against the documented
 * namespace path.
 */
const readPreScriptValue = <T>(key: string): T | undefined => {
  const viaSdk = getPreScriptValue<T>(key);
  if (viaSdk !== undefined) return viaSdk;
  const ns = (globalThis as { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } }).__openTabs
    ?.preScript?.['microsoft-word'];
  return ns?.[key] as T | undefined;
};

const isCapturedGraphToken = (value: unknown): value is CapturedGraphToken =>
  isRecord(value) && typeof value.token === 'string' && value.token.length > 0 && typeof value.exp === 'number';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** The token captured by the pre-script during this page load. */
const readNamespaceToken = (): CapturedGraphToken | null => {
  const captured = readPreScriptValue<unknown>(PRE_SCRIPT_TOKEN_KEY);
  return isCapturedGraphToken(captured) ? captured : null;
};

/** The token the pre-script mirrored to localStorage, shared by every same-origin tab. */
const readMirrorToken = (): CapturedGraphToken | null => {
  try {
    const raw = getLocalStorage(LS_TOKEN_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCapturedGraphToken(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * A plaintext Graph access token from the standalone `word.cloud.microsoft`
 * app's MSAL localStorage cache, keyed by client id and scope. Prefers a live
 * entry; when every Graph entry has expired the first expired one is returned
 * so diagnostics can report it, and `usableToken` rejects it for requests.
 */
const readMsalToken = (): CapturedGraphToken | null => {
  const tokenKeysRaw = getLocalStorage(`msal.token.keys.${MSAL_CLIENT_ID}`);
  const keysSource = tokenKeysRaw ?? findLocalStorageEntry(key => key.startsWith('msal.token.keys.'))?.value;
  if (!keysSource) return null;

  let tokenKeys: { accessToken?: string[] };
  try {
    tokenKeys = JSON.parse(keysSource);
  } catch {
    return null;
  }
  if (!tokenKeys.accessToken) return null;

  let expired: CapturedGraphToken | null = null;
  for (const key of tokenKeys.accessToken) {
    if (!/(?:^|[\s/])graph\.microsoft\.com(?:[/\s]|$)/.test(key)) continue;
    const raw = getLocalStorage(key);
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || typeof parsed.secret !== 'string' || parsed.secret.length === 0) continue;
      // MSAL stores `expiresOn` as a unix-epoch-seconds string. A missing or
      // unparseable value means we cannot prove the token is live — treat it as
      // expired rather than risk returning a stale token.
      const exp = Number.parseInt(String(parsed.expiresOn ?? '0'), 10);
      const captured = { token: parsed.secret, exp: Number.isNaN(exp) ? 0 : exp };
      if (captured.exp > nowSec()) return captured;
      expired ??= captured;
    } catch {
      // skip invalid token entries
    }
  }
  return expired;
};

const TOKEN_SOURCE_READERS: Record<GraphTokenSource, () => CapturedGraphToken | null> = {
  preScript: readNamespaceToken,
  localStorageMirror: readMirrorToken,
  msalPlaintext: readMsalToken,
};

/** A captured token is usable if it is not about to expire. */
const usableToken = (captured: CapturedGraphToken | null): string | null =>
  captured !== null && captured.exp > nowSec() + TOKEN_EXPIRY_MARGIN_SEC ? captured.token : null;

/** The first usable token across GRAPH_TOKEN_SOURCES, in order. */
const getToken = (): string | null => {
  for (const source of GRAPH_TOKEN_SOURCES) {
    const token = usableToken(TOKEN_SOURCE_READERS[source]());
    if (token) return token;
  }
  return null;
};

/** The source `getToken` currently draws from; null when no source holds a usable token. */
export const activeTokenSource = (): GraphTokenSource | null =>
  GRAPH_TOKEN_SOURCES.find(source => usableToken(TOKEN_SOURCE_READERS[source]()) !== null) ?? null;

const decodeBase64Url = (segment: string): string | null => {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch {
    return null;
  }
};

/** Host of the JWT `aud` claim (or the raw claim for a non-URL audience such as Graph's app id). */
const tokenAudience = (token: string): string | null => {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  const text = decodeBase64Url(payload);
  if (text === null) return null;
  try {
    const claims: unknown = JSON.parse(text);
    if (!isRecord(claims) || typeof claims.aud !== 'string' || claims.aud === '') return null;
    try {
      return new URL(claims.aud).host;
    } catch {
      return claims.aud;
    }
  } catch {
    return null;
  }
};

const capturedAgoSec = (): number | null => {
  const capturedAt = readPreScriptValue<unknown>(PRE_SCRIPT_CAPTURED_AT_KEY);
  return typeof capturedAt === 'number' ? Math.max(0, Math.round((Date.now() - capturedAt) / 1000)) : null;
};

/** Describes every token source for the diagnose tool. Never includes a token value. */
export const describeTokenSources = (): TokenSourceReport[] =>
  GRAPH_TOKEN_SOURCES.map(source => {
    const captured = TOKEN_SOURCE_READERS[source]();
    return {
      source,
      present: captured !== null,
      expiresInSec: captured === null ? null : captured.exp - nowSec(),
      audience: captured === null ? null : tokenAudience(captured.token),
      fingerprint: captured === null ? null : tokenFingerprint(captured.token),
      capturedAgoSec: source === 'preScript' ? capturedAgoSec() : null,
    };
  });

export const isAuthenticated = (): boolean => getToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 8000 }).then(
    () => true,
    () => false,
  );

const isSharePointDocumentUrl = (url: URL): boolean =>
  url.hostname.endsWith('.sharepoint.com') && url.pathname.includes('/:w:/');

/** True when the current tab is a SharePoint/OneDrive-hosted Word document. */
export const isSharePointDocument = (): boolean => {
  try {
    return isSharePointDocumentUrl(new URL(getCurrentUrl()));
  } catch {
    return false;
  }
};

export type PageKind = 'cloud-app' | 'sharepoint' | 'other';

/** Which Word surface the current tab is: the standalone app, a SharePoint/OneDrive document, or neither. */
export const describePageKind = (): PageKind => {
  const url = new URL(getCurrentUrl());
  if (isSharePointDocumentUrl(url)) return 'sharepoint';
  return url.hostname === CLOUD_APP_HOSTNAME ? 'cloud-app' : 'other';
};

/**
 * Trailing guidance appended to AUTH_ERROR messages on SharePoint/OneDrive
 * documents. MSAL's encrypted cache means we can't recover in-place — the only
 * reliable path is to clear MSAL state and reload, which the
 * `microsoft-word__reauthenticate` tool does.
 */
const SP_REAUTH_HINT = 'Call `microsoft-word__reauthenticate` to recover.';

/** User-facing message when no Graph token is available at all. */
export const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated — please sign in to Microsoft 365.';

/** User-facing message when Graph rejects the token as expired (401/403). */
export const AUTH_EXPIRED_MESSAGE = 'Authentication expired — please refresh the page.';

/**
 * Throw an AUTH_ERROR, appending the reauth hint on SharePoint documents.
 * Clears the adapter's cached token first so the next call re-reads fresh auth
 * state — every auth failure path resets the cache through this single helper.
 * `details` carries the audit-log facts of the Graph response that rejected
 * the token; the no-token path has no response and passes none.
 */
const authError = (msg: string, details?: ToolErrorDetails): never => {
  clearAuthCache('microsoft-word');
  const error = ToolError.auth(isSharePointDocument() ? `${msg} ${SP_REAUTH_HINT}` : msg);
  throw details === undefined ? error : error.withDetails(details);
};

/**
 * Guidance for HTTP 423 from Graph `/content`. The file is held by a WOPI
 * co-authoring lock — almost always because it is open in the Word web editor
 * in this very browser. Graph cannot overwrite a locked file, so the only path
 * is to close the editor (or wait for the lock to lapse) and retry.
 */
export const FILE_LOCKED_MESSAGE =
  'The document is locked because it is open in the Word web editor (or another co-authoring session), ' +
  'so Microsoft Graph cannot save changes to it. Close the editor tab — or wait ~30–60 seconds after closing ' +
  'for the lock to release — then retry.';

interface DocumentContext {
  driveId: string;
  itemId: string;
}

/** How the open document's drive/item ids are found: from the URL query, or by resolving the sharing URL via Graph `/shares`. */
export type DocumentContextSource = 'url' | 'shares';

/**
 * Per-tab cache keyed by the page URL. The Office apps are SPAs — same-tab
 * navigation to a different document changes `getCurrentUrl()` without
 * reloading the adapter, so a single-slot cache would silently return the
 * wrong drive/item. Comparing the URL on every read invalidates the cache
 * exactly when the document identity changes.
 */
let cached: { url: string; ctx: DocumentContext } | null = null;

/** Encode a sharing URL into a Graph `/shares` share id (unpadded base64url with a `u!` prefix). */
const encodeShareId = (sharingUrl: string): string => {
  const bytes = new TextEncoder().encode(sharingUrl);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return `u!${base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
};

/** The `driveId`/`docId` query the standalone app carries, when both are present. */
const documentIdsFromUrl = (url: URL): DocumentContext | null => {
  const driveId = url.searchParams.get('driveId');
  const itemId = url.searchParams.get('docId');
  return driveId && itemId ? { driveId, itemId } : null;
};

/** Graph endpoint that resolves the current SharePoint sharing URL to its drive item. */
const sharedDocumentItemEndpoint = (): string => `/shares/${encodeShareId(getCurrentUrl())}/driveItem`;

/** Where `resolveDocumentContext` would look for the open document's ids; null on a page without a document. */
export const describeDocumentContextSource = (): DocumentContextSource | null => {
  const url = new URL(getCurrentUrl());
  if (documentIdsFromUrl(url)) return 'url';
  return isSharePointDocumentUrl(url) ? 'shares' : null;
};

/**
 * Resolve the open document's drive and item ids.
 *
 * The standalone `word.cloud.microsoft` app carries `driveId`/`docId` in the URL
 * query. SharePoint/OneDrive-hosted documents identify the file by a sharing
 * token in the path, resolved to `{driveId, itemId}` via Graph `/shares`.
 * Returns null when no document context is available (e.g. a file-browser page).
 */
export const resolveDocumentContext = async (): Promise<DocumentContext | null> => {
  const currentUrl = getCurrentUrl();
  if (cached && cached.url === currentUrl) return cached.ctx;
  const url = new URL(currentUrl);
  const fromUrl = documentIdsFromUrl(url);
  if (fromUrl) {
    cached = { url: currentUrl, ctx: fromUrl };
    return fromUrl;
  }
  if (isSharePointDocumentUrl(url)) {
    const item = await api<{ id?: string; parentReference?: { driveId?: string } }>(sharedDocumentItemEndpoint(), {
      query: { $select: 'id,parentReference' },
    });
    const resolvedDriveId = item.parentReference?.driveId;
    if (resolvedDriveId && item.id) {
      const ctx = { driveId: resolvedDriveId, itemId: item.id };
      cached = { url: currentUrl, ctx };
      return ctx;
    }
  }
  return null;
};

/**
 * The Office reload marker for this document load: the one the pre-script
 * captured at document_start (Office may strip the `wdrldr*` query via
 * replaceState before the adapter runs), else one parsed from the current URL
 * for tabs that were open before the plugin registered.
 */
export const readReloadMarker = (): ReloadMarker | null =>
  readPreScriptValue<ReloadMarker>(PRE_SCRIPT_RELOAD_MARKER_KEY) ??
  parseReloadMarker(new URL(getCurrentUrl()).search, Date.now());

type QueryParams = Record<string, string | number | boolean | undefined>;

const graphUrl = (endpoint: string, query: QueryParams | undefined): string => {
  const qs = query ? buildQueryString(query) : '';
  return qs ? `${GRAPH_API_BASE}${endpoint}?${qs}` : `${GRAPH_API_BASE}${endpoint}`;
};

const isTimeoutError = (error: unknown): boolean => error instanceof DOMException && error.name === 'TimeoutError';

/** ` (request-id <id>)` when the response exposes an upstream correlation id, else empty. */
const requestIdSuffix = (response: Response): string => {
  const requestId = readUpstreamRequestId(response.headers);
  return requestId === null ? '' : ` (request-id ${requestId})`;
};

/**
 * Audit-log details for a ToolError classified from a Graph response: the
 * HTTP status and, when the upstream exposed one, its request id — never the URL.
 */
const responseErrorDetails = (response: Response): ToolErrorDetails => {
  const requestId = readUpstreamRequestId(response.headers);
  return requestId === null ? { httpStatus: response.status } : { httpStatus: response.status, requestId };
};

/** A response fetchWithRetry treats as transient, or one the front door refused before forwarding. */
const isUpstreamFailure = (response: Response): boolean =>
  TRANSIENT_HTTP_STATUSES.has(response.status) || isFrontDoorRefusal(response);

/** `error.message` from a Graph JSON error envelope; null when the body is not one. Consumes the body. */
const readGraphErrorMessage = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' && body.error.message !== '') {
      return body.error.message;
    }
  } catch {
    // not JSON — fall through to the status-based message
  }
  return null;
};

/**
 * Throws the ToolError for a non-ok Graph response. 401/403 clear the token
 * cache and become AUTH_ERROR; 404 NOT_FOUND; 423 the co-authoring lock
 * guidance; 429 RATE_LIMITED with Retry-After; a transient status or a
 * front-door refusal UPSTREAM_UNAVAILABLE naming `attempts`, the count
 * fetchWithRetry actually made; 400/409/422 VALIDATION_ERROR with Graph's
 * message; anything else INTERNAL_ERROR. Every message carries the upstream
 * request id when the response exposes one, and every error's `details`
 * carry the status and request id for the audit log.
 */
const classifyGraphFailure = async (response: Response, attempts: number): Promise<never> => {
  const { status } = response;
  const details = responseErrorDetails(response);
  if (status === 401 || status === 403) {
    void response.body?.cancel().catch(() => undefined);
    return authError(`${AUTH_EXPIRED_MESSAGE}${requestIdSuffix(response)}`, details);
  }
  if (status === 404) {
    void response.body?.cancel().catch(() => undefined);
    throw ToolError.notFound(`The requested resource was not found.${requestIdSuffix(response)}`).withDetails(details);
  }
  if (status === 423) {
    void response.body?.cancel().catch(() => undefined);
    throw ToolError.validation(`${FILE_LOCKED_MESSAGE}${requestIdSuffix(response)}`).withDetails(details);
  }
  if (status === 429) {
    void response.body?.cancel().catch(() => undefined);
    const retryAfter = response.headers.get('Retry-After');
    const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
    throw ToolError.rateLimited(
      `Microsoft Graph API rate limit exceeded.${requestIdSuffix(response)}`,
      retryMs,
    ).withDetails(details);
  }
  if (isUpstreamFailure(response)) {
    throw await upstreamUnavailableError(response, { host: GRAPH_HOST, attempts });
  }
  const message = `${(await readGraphErrorMessage(response)) ?? `Microsoft Graph API error (${status})`}${requestIdSuffix(response)}`;
  if (status === 400 || status === 409 || status === 422) throw ToolError.validation(message).withDetails(details);
  throw ToolError.internal(message).withDetails(details);
};

export interface GraphFetchOptions {
  /** HTTP method (default GET). */
  method?: string;
  /** Request body sent as-is; set `contentType` alongside it. */
  body?: BodyInit;
  /** Content-Type header for `body`. */
  contentType?: string;
  query?: QueryParams;
  /**
   * Overall budget for the request including retries and their backoff
   * sleeps (default DEFAULT_TIMEOUT_MS). Its expiry surfaces as TIMEOUT.
   */
  timeoutMs?: number;
  /**
   * Replay a POST/PUT/PATCH/DELETE on a transient failure. Set only where the
   * replay is provably harmless — a fixed-body `/content` PUT, a POST that
   * returns an existing resource or performs a pure read. Never set it for a
   * call that creates, copies or restores something per invocation.
   */
  retryNonIdempotent?: boolean;
  /**
   * The item version this write expects to replace, sent as `If-Match`. Graph
   * answers 412 when the item has moved on, so a write cannot silently discard
   * an edit made between the read and the write.
   */
  ifMatch?: string;
}

/**
 * The single choke point for Microsoft Graph requests. Attaches the bearer
 * token, retries transient failures through fetchWithRetry (GET/HEAD/OPTIONS
 * by default, other methods only with `retryNonIdempotent`, and any method
 * when the front door refused the request before forwarding it), and resolves
 * with the ok Response. Every other outcome throws: an exhausted transient
 * status UPSTREAM_UNAVAILABLE, an exhausted connection failure NETWORK_ERROR,
 * the request timeout TIMEOUT, and each non-ok status its classification.
 * The `timeoutMs` budget is one AbortSignal.timeout passed as the request
 * signal: fetchWithRetry sleeps its backoff on that same signal, so the
 * budget also cuts a pending Retry-After wait short and the TimeoutError it
 * raises is mapped to TIMEOUT whether it fired during a request or a sleep.
 * Upstream and network errors name the number of attempts fetchWithRetry
 * actually made, observed through its `onRetry` callback.
 */
export const graphFetch = async (endpoint: string, options: GraphFetchOptions = {}): Promise<Response> => {
  const token = getToken();
  if (!token) return authError(NOT_AUTHENTICATED_MESSAGE);

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.contentType !== undefined) headers['Content-Type'] = options.contentType;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  const tracker = createAttemptTracker();

  let response: Response;
  try {
    response = await fetchWithRetry(
      graphUrl(endpoint, options.query),
      {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        credentials: 'omit',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
      {
        maxAttempts: MAX_ATTEMPTS,
        retryNonIdempotent: options.retryNonIdempotent ?? false,
        isTransient: isFrontDoorRefusal,
        label: 'graph',
        onRetry: tracker.onRetry,
      },
    );
  } catch (error) {
    if (isTimeoutError(error)) throw ToolError.timeout('Microsoft Graph API request timed out.');
    throw recodeFetchFailure(error, GRAPH_HOST, tracker.attempts());
  }

  if (response.ok) return response;
  return classifyGraphFailure(response, tracker.attempts());
};

export interface GraphApiOptions {
  method?: string;
  /** JSON request body. */
  body?: unknown;
  query?: QueryParams;
  timeoutMs?: number;
  /** See GraphFetchOptions.retryNonIdempotent. */
  retryNonIdempotent?: boolean;
}

/**
 * Make an authenticated JSON request to the Microsoft Graph API through
 * `graphFetch`. Resolves with the parsed body, or an empty object for the
 * bodiless 202 Accepted and 204 No Content answers.
 */
export const api = async <T>(endpoint: string, options: GraphApiOptions = {}): Promise<T> => {
  const response = await graphFetch(endpoint, {
    method: options.method,
    query: options.query,
    timeoutMs: options.timeoutMs,
    retryNonIdempotent: options.retryNonIdempotent,
    ...(options.body !== undefined && { body: JSON.stringify(options.body), contentType: 'application/json' }),
  });
  if (response.status === 202 || response.status === 204) {
    void response.body?.cancel().catch(() => undefined);
    return {} as T;
  }
  return (await response.json()) as T;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
};

/**
 * Download file bytes from a Graph `@microsoft.graph.downloadUrl`. The URL is
 * pre-authenticated (a short-lived SAS link on a SharePoint or OneDrive host),
 * so the request carries no Authorization header and no cookies. Transient
 * failures are retried like any GET; an exhausted one throws
 * UPSTREAM_UNAVAILABLE, any other non-ok status INTERNAL_ERROR. The
 * `timeoutMs` budget bounds the whole exchange the way graphFetch's does —
 * requests and backoff sleeps alike — and its expiry throws TIMEOUT. Errors
 * and logs name the host only, never the URL.
 */
export const fetchDownloadUrl = async (
  downloadUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<Response> => {
  const host = hostOf(downloadUrl);
  const tracker = createAttemptTracker();
  let response: Response;
  try {
    response = await fetchWithRetry(
      downloadUrl,
      { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
      { maxAttempts: MAX_ATTEMPTS, isTransient: isFrontDoorRefusal, label: 'download', onRetry: tracker.onRetry },
    );
  } catch (error) {
    if (isTimeoutError(error)) throw ToolError.timeout('File download timed out.');
    throw recodeFetchFailure(error, host, tracker.attempts());
  }

  if (response.ok) return response;
  if (isUpstreamFailure(response)) {
    throw await upstreamUnavailableError(response, { host, attempts: tracker.attempts() });
  }
  void response.body?.cancel().catch(() => undefined);
  throw ToolError.internal(`File download failed (${response.status}).${requestIdSuffix(response)}`).withDetails(
    responseErrorDetails(response),
  );
};

/**
 * One un-retried, unclassified GET at a Graph endpoint for the diagnose tool.
 * `path` is the label recorded in the result — a template such as
 * `/shares/{shareId}/driveItem`, never an encoded id. Without a usable token
 * the probe records an AUTH_ERROR instead of sending a request.
 */
const probeGraph = (name: string, path: string, endpoint: string, query?: QueryParams): Promise<ProbeResult> =>
  runProbe(name, path, async () => {
    const token = getToken();
    if (!token) throw ToolError.auth(NOT_AUTHENTICATED_MESSAGE);
    return fetch(graphUrl(endpoint, query), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  });

/** Probes the signed-in user — the cheapest call that proves the token is accepted by Graph. */
export const probeCurrentUser = (): Promise<ProbeResult> => probeGraph('graph:/me', '/me', '/me', { $select: 'id' });

/** Probes the `/shares` resolution of the current SharePoint document URL — the call every document tool depends on there. */
export const probeSharedDocumentItem = (): Promise<ProbeResult> =>
  probeGraph('graph:/shares', '/shares/{shareId}/driveItem', sharedDocumentItemEndpoint(), {
    $select: 'id,parentReference',
  });
