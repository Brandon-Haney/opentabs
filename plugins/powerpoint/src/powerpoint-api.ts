import {
  buildQueryString,
  fetchWithRetry,
  findLocalStorageEntry,
  getCurrentUrl,
  getLocalStorage,
  getPageGlobal,
  getPreScriptValue,
  parseRetryAfterMs,
  ToolError,
  type ToolErrorDetails,
  TRANSIENT_HTTP_STATUSES,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';
import { type ProbeResult, runProbe } from './diagnostics.js';
import { jwtClaims } from './jwt-claims.js';
import {
  createAttemptTracker,
  isFrontDoorRefusal,
  readUpstreamRequestId,
  recodeFetchFailure,
  upstreamUnavailableError,
} from './microsoft-upstream.js';
import { isAnonymousLinkPage } from './page-identity.js';
import { parseReloadMarker, type ReloadMarker } from './reload-marker-parse.js';
import { tokenFingerprint } from './token-fingerprint.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const GRAPH_HOST = new URL(GRAPH_ORIGIN).host;
const MSAL_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';
/** localStorage key the pre-script mirrors the captured Graph token to. */
const LS_TOKEN_KEY = '__opentabs_powerpoint_graph_token';
/** Attempts fetchWithRetry may spend on one Graph request, the first included. */
const GRAPH_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

// --- SharePoint detection ---

/** True when the current tab is hosted on a SharePoint/OneDrive site. */
export const isSharePoint = (): boolean => {
  try {
    return new URL(getCurrentUrl()).hostname.toLowerCase().endsWith('.sharepoint.com');
  } catch {
    return false;
  }
};

/**
 * True when the current tab is a SharePoint/OneDrive-hosted PowerPoint
 * presentation (`*.sharepoint.com/:p:/...`). These are the pages where MSAL's
 * localStorage cache is encrypted, so a stale captured token can only be
 * recovered by clearing MSAL state and reloading.
 */
export const isSharePointPresentation = (): boolean => {
  try {
    const url = new URL(getCurrentUrl());
    return url.hostname.toLowerCase().endsWith('.sharepoint.com') && url.pathname.includes('/:p:/');
  } catch {
    return false;
  }
};

/**
 * Whether the current tab is a PowerPoint document.
 * Accepts the dedicated PowerPoint cloud app, SharePoint PowerPoint viewer URLs (`/:p:/`),
 * and any URL referencing a `.ppt`/`.pptx`/`.pptm`/`.ppsx` file.
 */
export const isPowerPointTab = (): boolean => {
  const url = getCurrentUrl();
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Malformed URL — fall through to URL pattern checks
  }
  if (host === 'powerpoint.cloud.microsoft') return true;
  if (/\/:p:\//i.test(url)) return true;
  if (/\.(?:pptx?|pptm|ppsx?)(?:[?#]|$)/i.test(url)) return true;
  return false;
};

// --- Auth ---
//
// Three token sources, tried in order:
//   1. The Graph token captured by the pre-script from MSAL's token-endpoint
//      responses, read from the in-page namespace — the path that works on
//      SharePoint/OneDrive-hosted presentations, where MSAL's localStorage
//      cache is encrypted.
//   2. The same captured token mirrored to localStorage, which survives warm
//      reloads that mint no new token.
//   3. A plaintext MSAL access token in localStorage, used by the standalone
//      `powerpoint.cloud.microsoft` app.

interface PowerPointAuth {
  token: string;
  driveId: string;
}

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

/** Where a Graph token can come from, in the order `getToken` consults them. */
export const GRAPH_TOKEN_SOURCES = ['preScript', 'localStorageMirror', 'msalPlaintext'] as const;
export type GraphTokenSource = (typeof GRAPH_TOKEN_SOURCES)[number];

/** What `diagnose` reports about one token source — never the token itself. */
export interface GraphTokenSourceStatus {
  source: GraphTokenSource;
  /** Whether the source holds a token at all, live or expired. */
  present: boolean;
  /** Seconds until the token expires; negative once expired; null when absent. */
  expiresInSec: number | null;
  /** Host of the token's `aud` claim (the raw claim when it is not a URL); null when absent or unreadable. */
  audience: string | null;
  /**
   * Last 4 hex digits of a 32-bit FNV-1a hash of the token — enough to tell
   * whether two sources hold the same token, and nothing about the token itself.
   */
  fingerprint: string | null;
}

/**
 * Read a value the pre-script stashed under the `powerpoint` namespace.
 *
 * `getPreScriptValue` depends on `globalThis.__openTabs._pluginName`, which the
 * adapter only binds during tool dispatch — so it returns `undefined` in
 * `isReady()` and `onActivate()`. We try the SDK helper first, then fall back
 * to a direct read.
 */
const readPreScriptValue = <T>(key: string): T | undefined => {
  const viaSdk = getPreScriptValue<T>(key);
  if (viaSdk !== undefined) return viaSdk;
  const ns = (globalThis as { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } }).__openTabs
    ?.preScript?.powerpoint;
  return ns?.[key] as T | undefined;
};

const isCapturedGraphToken = (value: unknown): value is CapturedGraphToken => {
  if (typeof value !== 'object' || value === null) return false;
  const { token, exp } = value as Partial<CapturedGraphToken>;
  return typeof token === 'string' && token.length > 0 && typeof exp === 'number' && Number.isFinite(exp);
};

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** The token when it is still live with a 30-second margin; null otherwise. */
const usableToken = (captured: CapturedGraphToken | null): string | null =>
  captured !== null && captured.exp > nowSec() + 30 ? captured.token : null;

/** The token the pre-script captured, from the in-page namespace. */
const readNamespaceToken = (): CapturedGraphToken | null => {
  const value = readPreScriptValue<unknown>('graph');
  return isCapturedGraphToken(value) ? value : null;
};

/** The token the pre-script captured, from its localStorage mirror. */
const readMirrorToken = (): CapturedGraphToken | null => {
  try {
    const raw = getLocalStorage(LS_TOKEN_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCapturedGraphToken(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** A plaintext Graph access token from the standalone app's MSAL localStorage. */
const readMsalToken = (): CapturedGraphToken | null => {
  const entry = findLocalStorageEntry(
    k =>
      k.includes('accesstoken') && /(?:^|[\s/])graph\.microsoft\.com(?:[/\s]|$)/.test(k) && k.includes(MSAL_CLIENT_ID),
  );
  if (!entry) return null;
  try {
    const data = JSON.parse(entry.value) as Record<string, unknown>;
    if (typeof data.secret !== 'string' || data.secret.length === 0) return null;
    // MSAL stores `expiresOn` as a unix-epoch-seconds string. A missing or
    // unparseable value means we cannot prove the token is live — treat it as
    // expired rather than risk returning a stale token.
    const expiresOn = Number.parseInt(String(data.expiresOn ?? '0'), 10);
    if (!Number.isFinite(expiresOn)) return null;
    return { token: data.secret, exp: expiresOn };
  } catch {
    return null;
  }
};

const TOKEN_READERS: Readonly<Record<GraphTokenSource, () => CapturedGraphToken | null>> = {
  preScript: readNamespaceToken,
  localStorageMirror: readMirrorToken,
  msalPlaintext: readMsalToken,
};

const getToken = (): string | null => {
  for (const source of GRAPH_TOKEN_SOURCES) {
    const token = usableToken(TOKEN_READERS[source]());
    if (token !== null) return token;
  }
  return null;
};

export const isAuthenticated = (): boolean => getToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 8000 }).then(
    () => true,
    () => false,
  );

/** Host of the `aud` claim when it is a URL, else the raw claim (Graph's app id in v1 tokens); null when absent. */
const audienceOf = (token: string): string | null => {
  const aud = jwtClaims(token)?.aud;
  if (typeof aud !== 'string' || aud === '') return null;
  try {
    return new URL(aud).host;
  } catch {
    return aud;
  }
};

/** Last 4 hex digits of the 32-bit FNV-1a hash of `text`. */

/**
 * Describes every token source for `diagnose`, without exposing any token
 * value. One clock reading serves every source, so a shared token reports the
 * same `expiresInSec` from each of them even across a second boundary.
 */
export const describeTokenSources = (): GraphTokenSourceStatus[] => {
  const now = nowSec();
  return GRAPH_TOKEN_SOURCES.map(source => {
    const captured = TOKEN_READERS[source]();
    return {
      source,
      present: captured !== null,
      expiresInSec: captured === null ? null : captured.exp - now,
      audience: captured === null ? null : audienceOf(captured.token),
      fingerprint: captured === null ? null : tokenFingerprint(captured.token),
    };
  });
};

/** The source whose token `getToken` would use right now; null when none holds a usable token. */
export const describeActiveTokenSource = (): GraphTokenSource | null =>
  GRAPH_TOKEN_SOURCES.find(source => usableToken(TOKEN_READERS[source]()) !== null) ?? null;

// --- Drive / item context ---

/** Where the current tab's drive id can come from. */
export const DRIVE_ID_SOURCES = ['url', 'wopi', 'msalAccount', 'shares'] as const;
export type DriveIdSource = (typeof DRIVE_ID_SOURCES)[number];

interface ResolvedDriveId {
  driveId: string;
  source: DriveIdSource;
}

/** Read the drive id synchronously from the URL query, the WOPI context, or the MSAL account. */
const readDriveIdSync = (): ResolvedDriveId | null => {
  // Primary: URL query param (powerpoint.cloud.microsoft)
  const url = new URL(getCurrentUrl());
  const urlDriveId = url.searchParams.get('driveId');
  if (urlDriveId) return { driveId: urlDriveId, source: 'url' };

  // SharePoint-hosted files: read from the WOPI context global
  const wopiDriveId = getPageGlobal('_wopiContextJson.DriveId') as string | undefined;
  if (wopiDriveId) return { driveId: wopiDriveId, source: 'wopi' };

  // Fallback: extract from the active MSAL account (powerpoint.cloud.microsoft)
  const activeAccount = getLocalStorage(`msal.${MSAL_CLIENT_ID}.active-account`);
  if (activeAccount) {
    const match = activeAccount.match(/00000000-0000-0000-([0-9a-f]{4}-[0-9a-f]{12})/i);
    const driveId = match?.[1]?.replace(/-/g, '').toUpperCase();
    if (driveId) return { driveId, source: 'msalAccount' };
  }

  return null;
};

/** Encode a sharing URL into a Graph `/shares` share id (unpadded base64url with a `u!` prefix). */
export const encodeShareId = (sharingUrl: string): string => {
  const bytes = new TextEncoder().encode(sharingUrl);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return `u!${base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
};

/**
 * Per-tab cache keyed by the page URL. The Office apps are SPAs — same-tab
 * navigation to a different presentation changes `getCurrentUrl()` without
 * reloading the adapter, so a single-slot cache would silently return the
 * wrong drive. Comparing the URL on every read invalidates the cache exactly
 * when the presentation identity changes.
 */
let cached: ({ url: string } & ResolvedDriveId) | null = null;

/**
 * Error codes from the `/shares` lookup that mean the page URL is not a
 * shareable drive item, so the drive stays unresolved. Every other failure —
 * an exhausted outage, a network error, a timeout, a rate limit, an expired
 * token — propagates with its own classification and guidance.
 */
const UNSHAREABLE_LOOKUP_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'VALIDATION_ERROR', 'ABORTED']);

/**
 * Resolve the current drive id. Uses the synchronous sources first, then falls
 * back to the Graph `/shares` endpoint for SharePoint URLs whose WOPI context
 * has not exposed a drive id. Passes the token through so the lookup does not
 * recurse through `requireAuth`. Resolves null only when no source names a
 * drive; a transport or auth failure of the lookup is rethrown.
 */
const resolveDriveId = async (token: string): Promise<string | null> => {
  const currentUrl = getCurrentUrl();
  if (cached && cached.url === currentUrl) return cached.driveId;
  const sync = readDriveIdSync();
  if (sync) {
    cached = { url: currentUrl, ...sync };
    return sync.driveId;
  }
  if (isSharePoint()) {
    try {
      const response = await graphFetch(`/shares/${encodeShareId(currentUrl)}/driveItem`, {
        query: { $select: 'id,parentReference' },
        token,
      });
      const item = (await response.json()) as { parentReference?: { driveId?: string } };
      const driveId = item.parentReference?.driveId;
      if (driveId) {
        cached = { url: currentUrl, driveId, source: 'shares' };
        return driveId;
      }
    } catch (err: unknown) {
      if (!(err instanceof ToolError && UNSHAREABLE_LOOKUP_CODES.has(err.code))) throw err;
    }
  }
  return null;
};

/**
 * Where the current tab's drive id comes from, without a network round trip:
 * a synchronous source when one exposes it, otherwise the source of a lookup
 * already made for this URL. Null when the drive id is not yet known.
 */
export const describeDriveIdSource = (): DriveIdSource | null => {
  const sync = readDriveIdSync();
  if (sync) return sync.source;
  return cached && cached.url === getCurrentUrl() ? cached.source : null;
};

/** Get the current file's item ID from the SharePoint WOPI context, if present. */
export const getCurrentItemId = (): string | null => {
  const wopiItemId = getPageGlobal('_wopiContextJson.DriveItemId') as string | undefined;
  return wopiItemId ?? null;
};

/**
 * The Office reload marker for this document: the one the pre-script captured
 * at document_start, or — for a tab that was open before the plugin registered,
 * so no pre-script ran — the one still on the current URL. Null when the
 * Office web app did not reload the document.
 */
export const readReloadMarker = (): ReloadMarker | null =>
  readPreScriptValue<ReloadMarker>('reloadMarker') ?? parseReloadMarker(new URL(getCurrentUrl()).search, Date.now());

/**
 * Trailing guidance appended to AUTH_ERROR messages on SharePoint/OneDrive
 * presentations. MSAL's encrypted cache means we can't recover in-place — the
 * only reliable path is to clear MSAL state and reload, which the
 * `powerpoint__reauthenticate` tool does.
 */
const SP_REAUTH_HINT = 'Call `powerpoint__reauthenticate` to recover.';

const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated — please log in to Microsoft 365.';

/** An AUTH_ERROR carrying the reauth hint on SharePoint presentations. */
const authError = (msg: string): ToolError =>
  ToolError.auth(isSharePointPresentation() ? `${msg} ${SP_REAUTH_HINT}` : msg);

/**
 * Why a page reached through an anonymous sharing link can never hold a Graph
 * token, and what still works there. The live tools are named so an agent can
 * act on the message without a second lookup.
 */
const ANONYMOUS_LINK_MESSAGE =
  'This presentation is open through an anonymous sharing link, so the page has no Microsoft 365 sign-in and Microsoft Graph is unavailable here. File, sharing, thumbnail, version and saved-copy tools cannot run on it, and `powerpoint__reauthenticate` cannot change that. The live tools — get_live_outline, set_text, format_text, set_font_size, align_text, add_slide_live, delete_slide_live, move_slide_live, set_slide_background — edit this deck through the editor session and work here.';
/** Error code for a Graph call on an anonymous-link page: an auth error no reauthentication can clear. */
const ANONYMOUS_LINK_CODE = 'ANONYMOUS_SHARING_LINK';

/**
 * The error for a page holding no usable Graph token. On an anonymous-link page
 * no token can ever exist, so the error says so instead of sending the caller
 * to `reauthenticate`.
 */
const notAuthenticatedError = (): ToolError =>
  isAnonymousLinkPage()
    ? ToolError.auth(ANONYMOUS_LINK_MESSAGE, ANONYMOUS_LINK_CODE)
    : authError(NOT_AUTHENTICATED_MESSAGE);

/**
 * Return the auth context, throwing an actionable error if unavailable.
 *
 * The Graph token comes from the pre-script capture (SharePoint) or the
 * standalone app's plaintext MSAL cache. It is a delegated token for
 * `https://graph.microsoft.com` carrying the signed-in user's full file scopes
 * (`Files.ReadWrite.All`, `Sites.ReadWrite.All`), so it addresses every drive
 * the user has rights on — not just the one the current tab happens to show.
 *
 * `explicitDriveId` therefore lets a caller operate on a file in someone
 * else's drive while the tab stays on an unrelated presentation. Only when it
 * is omitted do we fall back to deriving the drive from the tab (URL, WOPI
 * context, or Graph `/shares`).
 */
export const requireAuth = async (explicitDriveId?: string): Promise<PowerPointAuth> => {
  const token = getToken();
  if (!token) throw notAuthenticatedError();
  if (explicitDriveId) return { token, driveId: explicitDriveId };
  const driveId = await resolveDriveId(token);
  if (!driveId) {
    throw ToolError.validation('Could not determine the current drive. Open a presentation in the browser first.');
  }
  return { token, driveId };
};

/**
 * The drive to operate on: the one the caller named, or the one the tab shows.
 *
 * File tools take the same `drive_id` as the presentation tools and for the same
 * reason — the token addresses every drive the user has rights on, so pinning
 * them to the tab's drive would make a file unreachable simply because the tab
 * moved on.
 */
export const requireDriveId = async (explicitDriveId?: string): Promise<string> =>
  (await requireAuth(explicitDriveId)).driveId;

// --- Graph request choke point ---

/**
 * Guidance for HTTP 423 from Graph `/content`. The file is held by a WOPI
 * co-authoring lock — almost always because it is open in the PowerPoint web
 * editor in this very browser. Graph cannot overwrite a locked file, so the
 * only path is to close the editor (or wait for the lock to lapse) and retry.
 *
 * The lock outlives the editor tab: the server keeps the co-authoring session
 * alive for several minutes after the last client disconnects, and no request
 * shortens that. Measured at roughly four minutes.
 */
export const FILE_LOCKED_MESSAGE =
  'The presentation is locked because it is open in the PowerPoint web editor (or another co-authoring session), so Microsoft Graph cannot save changes to it. Close the editor tab and retry — the server holds the lock for a few minutes after the last editor disconnects, so expect to wait rather than to retry immediately. Any pending session edits are preserved.';

export interface GraphFetchOptions {
  /** HTTP method (default GET). */
  method?: string;
  /** Query parameters appended to the endpoint; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Request body, sent as given with `contentType`. `api()` serializes JSON on top of this. */
  body?: BodyInit;
  /** `Content-Type` for `body`. */
  contentType?: string;
  /** Additional request headers, e.g. `If-Match`. */
  headers?: Record<string, string>;
  /** Per-request timeout (default 30 s); one clock spans every retry attempt. */
  timeoutMs?: number;
  /** A bearer token already resolved by the caller; otherwise the page's current token is used. */
  token?: string;
  /**
   * Replay a POST/PUT/PATCH/DELETE on a transient failure. Off by default;
   * enable only where a replay after a hidden success provably changes nothing.
   * A front-door refusal (the request never left Microsoft's routing plane) is
   * replayed for every method regardless.
   */
  retryNonIdempotent?: boolean;
  /** Hand a 412 back as a Response instead of throwing — for callers that own the `If-Match` precondition. */
  allowPreconditionFailed?: boolean;
}

/** ` (request-id …)` suffix for error messages, so a failure can be correlated with Microsoft's logs. */
const requestIdSuffix = (response: Response): string => {
  const requestId = readUpstreamRequestId(response.headers);
  return requestId === null ? '' : ` (request-id ${requestId})`;
};

/**
 * Audit-log details for a ToolError classified from a Microsoft response: the
 * HTTP status and, when the upstream exposed one, its request id — never the URL.
 */
const responseErrorDetails = (response: Response): ToolErrorDetails => {
  const requestId = readUpstreamRequestId(response.headers);
  return requestId === null ? { httpStatus: response.status } : { httpStatus: response.status, requestId };
};

/**
 * Turns a non-ok Graph response into the ToolError to throw. Transient statuses
 * (fetchWithRetry has already retried them as far as its policy allows) become
 * UPSTREAM_UNAVAILABLE naming `attempts`, the number of requests fetchWithRetry
 * actually sent as observed by an AttemptTracker; 429 keeps its RATE_LIMITED
 * classification with the Retry-After delay; 401/403 are AUTH_ERROR with the
 * SharePoint reauth hint; 404 NOT_FOUND; 400/409/412/422 VALIDATION_ERROR; 423
 * the co-authoring lock explanation; everything else INTERNAL_ERROR. Consumes
 * the response body. Messages carry the status, a label, the response body and
 * the request id — never the endpoint, which names drive and item ids — and
 * every status-classified error carries `{ httpStatus, requestId }` as details
 * for the audit log.
 */
const classifyGraphFailure = async (response: Response, attempts: number): Promise<ToolError> => {
  const { status } = response;
  if (status !== 429 && TRANSIENT_HTTP_STATUSES.has(status)) {
    return upstreamUnavailableError(response, { host: GRAPH_HOST, attempts });
  }
  const errorBody = (await response.text().catch(() => '')).substring(0, 512);
  const describe = (label: string): string =>
    `Microsoft Graph returned ${status} (${label})${errorBody === '' ? '' : `: ${errorBody}`}${requestIdSuffix(response)}`;
  const details = responseErrorDetails(response);
  if (status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    return ToolError.rateLimited(
      describe('Rate limited'),
      retryAfter === null ? undefined : parseRetryAfterMs(retryAfter),
    ).withDetails(details);
  }
  if (status === 401 || status === 403) return authError(describe('Auth error')).withDetails(details);
  if (status === 404) return ToolError.notFound(describe('Not found')).withDetails(details);
  if (status === 412) {
    return ToolError.validation(describe('Precondition failed — the file changed since it was read')).withDetails(
      details,
    );
  }
  if (status === 423) return ToolError.validation(FILE_LOCKED_MESSAGE).withDetails(details);
  if (status === 400 || status === 409 || status === 422) {
    return ToolError.validation(describe('Validation error')).withDetails(details);
  }
  return ToolError.internal(describe('Unexpected error')).withDetails(details);
};

/**
 * Every Microsoft Graph request the plugin makes goes through here. Sends a
 * bearer-authenticated request (never cookies) through fetchWithRetry, so a
 * network failure or a transient status is retried for GET/HEAD/OPTIONS, for
 * other methods only with `retryNonIdempotent`, and for any method when
 * Microsoft's front door refused the request before forwarding it. Resolves
 * with an ok Response (or a 412 when `allowPreconditionFailed` is set) and
 * throws a classified ToolError for everything else: TIMEOUT when the
 * per-request clock runs out, NETWORK_ERROR / ABORTED from the fetch layer,
 * and the status classification of `classifyGraphFailure`. Every upstream and
 * network error names the number of attempts fetchWithRetry actually made, as
 * observed through its `onRetry` callback.
 */
export const graphFetch = async (endpoint: string, options: GraphFetchOptions = {}): Promise<Response> => {
  const token = options.token ?? getToken();
  if (!token) throw notAuthenticatedError();
  const method = (options.method ?? 'GET').toUpperCase();
  const qs = options.query ? buildQueryString(options.query) : '';
  const url = qs ? `${GRAPH_BASE}${endpoint}?${qs}` : `${GRAPH_BASE}${endpoint}`;
  const headers: Record<string, string> = { ...options.headers, Authorization: `Bearer ${token}` };
  if (options.contentType !== undefined) headers['Content-Type'] = options.contentType;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tracker = createAttemptTracker();

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      { method, headers, body: options.body, credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) },
      {
        maxAttempts: GRAPH_MAX_ATTEMPTS,
        retryNonIdempotent: options.retryNonIdempotent ?? false,
        isTransient: isFrontDoorRefusal,
        onRetry: tracker.onRetry,
      },
    );
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw ToolError.timeout(`Microsoft Graph request timed out after ${timeoutMs} ms`);
    }
    throw recodeFetchFailure(err, GRAPH_HOST, tracker.attempts());
  }

  if (response.ok) return response;
  if (response.status === 412 && options.allowPreconditionFailed === true) return response;
  throw await classifyGraphFailure(response, tracker.attempts());
};

/** Host of a URL for error messages; `<invalid-url>` when it does not parse. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
};

/**
 * Downloads from a pre-authenticated `@microsoft.graph.downloadUrl`. The URL
 * itself carries the authorization, so no bearer header and no cookies are
 * sent. Retried like a GET; a transient status that outlasts the retries is
 * UPSTREAM_UNAVAILABLE and any other failure INTERNAL_ERROR carrying
 * `{ httpStatus, requestId }` as details. Messages name the host only — the
 * URL embeds a bearer-equivalent secret.
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
      { credentials: 'omit', signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
      { maxAttempts: GRAPH_MAX_ATTEMPTS, isTransient: isFrontDoorRefusal, onRetry: tracker.onRetry },
    );
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw ToolError.timeout(`Download from ${host} timed out`);
    throw recodeFetchFailure(err, host, tracker.attempts());
  }
  if (response.ok) return response;
  if (TRANSIENT_HTTP_STATUSES.has(response.status)) {
    throw await upstreamUnavailableError(response, { host, attempts: tracker.attempts() });
  }
  void response.body?.cancel().catch(() => undefined);
  throw ToolError.internal(
    `Failed to download the presentation from ${host} (${response.status})${requestIdSuffix(response)}`,
  ).withDetails(responseErrorDetails(response));
};

// --- JSON API caller ---

export interface ApiOptions {
  method?: string;
  /** JSON-serialized request body. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** See {@link GraphFetchOptions.retryNonIdempotent}. */
  retryNonIdempotent?: boolean;
}

/** JSON request to Microsoft Graph through `graphFetch`; 202/204 resolve with an empty object. */
export const api = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> => {
  const response = await graphFetch(endpoint, {
    method: options.method,
    query: options.query,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    contentType: options.body === undefined ? undefined : 'application/json',
    retryNonIdempotent: options.retryNonIdempotent,
  });
  if (response.status === 202 || response.status === 204) return {} as T;
  return (await response.json()) as T;
};

// --- Diagnostics ---

/**
 * One un-retried, unclassified Graph GET for `diagnose`, so the result shows
 * the raw upstream behavior. `path` is the label recorded in the result and
 * must not contain an encoded share id or a full URL; `endpoint` is what is
 * actually requested. Without a usable token the probe records the auth error
 * instead of sending anything.
 */
export const probeGraph = (
  name: string,
  path: string,
  endpoint: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<ProbeResult> =>
  runProbe(name, path, async () => {
    const token = getToken();
    if (!token) throw notAuthenticatedError();
    const qs = query ? buildQueryString(query) : '';
    return fetch(qs ? `${GRAPH_BASE}${endpoint}?${qs}` : `${GRAPH_BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  });
