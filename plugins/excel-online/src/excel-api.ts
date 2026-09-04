import {
  buildQueryString,
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
import { parseReloadMarker, type ReloadMarker } from './reload-marker.js';
import { tokenFingerprint } from './token-fingerprint.js';
import { audienceOf, decodeJwtClaims, scopesOf } from './token-introspection.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_HOST = new URL(GRAPH_ORIGIN).host;
/** Microsoft Graph base URL every tool and probe targets. */
export const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
/** localStorage key the pre-script mirrors the captured Graph token to. */
const LS_TOKEN_KEY = '__opentabs_excel_graph_token';
/** Budget for a Graph request whose endpoint answers promptly. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Attempts fetchWithRetry may spend on one Graph request whose policy allows a replay. */
const GRAPH_MAX_ATTEMPTS = 3;

// --- Auth ---
//
// Three token sources, tried in order:
//   1. The Graph token captured by the pre-script from MSAL's token-endpoint
//      responses, read from the in-page pre-script namespace (set on the
//      current load). This is the path that works on SharePoint/OneDrive-hosted
//      workbooks, where MSAL's localStorage cache is encrypted.
//   2. The localStorage mirror of that captured token (persisted across warm
//      reloads and same-origin tabs for the token's lifetime).
//   3. A plaintext MSAL access token in localStorage, used by the standalone
//      `excel.cloud.microsoft` app, which keys its Graph token by client id.

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

export const GRAPH_TOKEN_SOURCES = ['preScript', 'localStorageMirror', 'msalPlaintext'] as const;
export type GraphTokenSource = (typeof GRAPH_TOKEN_SOURCES)[number];

/** Non-secret description of one token source for the diagnose tool. */
export interface GraphTokenSourceDescriptor {
  source: GraphTokenSource;
  /** Whether the source currently holds a token at all, expired or not. */
  present: boolean;
  /** Seconds until the token expires; negative once expired; null when absent. */
  expiresInSec: number | null;
  /** Token audience: the host of a URL `aud` claim, else the raw application id; null when unreadable. */
  audience: string | null;
  /** Delegated scopes from the `scp` claim; empty when unreadable. */
  scopes: string[];
  /** Last 4 hex digits of the token's FNV-1a hash — identifies the token without revealing it. */
  fingerprint: string | null;
  /** Seconds since the pre-script captured the token; null for other sources or when unrecorded. */
  capturedAgoSec: number | null;
}

/**
 * Read a value the pre-script stashed under the `excel-online` namespace.
 *
 * `getPreScriptValue` depends on `globalThis.__openTabs._pluginName`, which the
 * adapter only binds during tool dispatch — so it returns `undefined` in
 * `isReady()` and `onActivate()`, which run earlier. The SDK helper is tried
 * first (forward-compat), then a direct read against the documented namespace
 * path.
 */
const readPreScriptValue = <T>(key: string): T | undefined => {
  const viaSdk = getPreScriptValue<T>(key);
  if (viaSdk !== undefined) return viaSdk;
  const ns = (globalThis as { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } }).__openTabs
    ?.preScript?.['excel-online'];
  return ns?.[key] as T | undefined;
};

const isCapturedGraphToken = (value: unknown): value is CapturedGraphToken =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CapturedGraphToken).token === 'string' &&
  (value as CapturedGraphToken).token.length > 0 &&
  typeof (value as CapturedGraphToken).exp === 'number';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** A captured token is usable if it is not about to expire. */
const usableToken = (captured: CapturedGraphToken | null): string | null =>
  captured !== null && captured.exp > nowSec() + 30 ? captured.token : null;

/** The token the pre-script captured on the current load. */
const readNamespaceToken = (): CapturedGraphToken | null => {
  const value = readPreScriptValue<unknown>('graph');
  return isCapturedGraphToken(value) ? value : null;
};

/** The pre-script's localStorage mirror of the captured token. */
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
 * A plaintext Graph access token from MSAL's localStorage cache.
 *
 * Used on the standalone `excel.cloud.microsoft` app, where MSAL.js stores
 * `secret` plaintext. Enterprise SharePoint pages encrypt the `data` field
 * (their entries have no `secret`), so the predicate naturally skips them and
 * the pre-script's captured token is used instead. Matched by key shape rather
 * than a hardcoded client ID — consumer vs enterprise tenants use different
 * IDs, and any plaintext Graph AT in storage is fair game.
 *
 * MSAL stores `expiresOn` as a unix-epoch-seconds string. A missing or
 * unparseable value yields `exp: 0`: the token cannot be proven live, so it
 * is treated as expired (MSAL leaves expired AT entries in storage until the
 * next refresh).
 */
const readMsalPlaintextToken = (): CapturedGraphToken | null => {
  const entry = findLocalStorageEntry(
    key => key.includes('accesstoken') && /(?:^|[\s/])graph\.microsoft\.com(?:[/\s]|$)/.test(key),
  );
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry.value) as Record<string, unknown>;
    if (typeof parsed.secret !== 'string' || parsed.secret.length === 0) return null;
    const expiresOn = Number.parseInt(String(parsed.expiresOn ?? '0'), 10);
    return { token: parsed.secret, exp: Number.isNaN(expiresOn) ? 0 : expiresOn };
  } catch {
    return null;
  }
};

const TOKEN_READERS: Record<GraphTokenSource, () => CapturedGraphToken | null> = {
  preScript: readNamespaceToken,
  localStorageMirror: readMirrorToken,
  msalPlaintext: readMsalPlaintextToken,
};

/** The first source, in GRAPH_TOKEN_SOURCES order, holding a usable token. */
export const activeTokenSource = (): GraphTokenSource | null =>
  GRAPH_TOKEN_SOURCES.find(source => usableToken(TOKEN_READERS[source]()) !== null) ?? null;

const getToken = (): string | null => {
  const source = activeTokenSource();
  return source === null ? null : usableToken(TOKEN_READERS[source]());
};

/**
 * Describes every token source without exposing a token: presence, expiry,
 * audience, scopes and a short fingerprint. Never throws — a malformed token
 * yields null descriptors.
 */
export const describeTokenSources = (): GraphTokenSourceDescriptor[] =>
  GRAPH_TOKEN_SOURCES.map(source => {
    const captured = TOKEN_READERS[source]();
    if (captured === null) {
      return {
        source,
        present: false,
        expiresInSec: null,
        audience: null,
        scopes: [],
        fingerprint: null,
        capturedAgoSec: null,
      };
    }
    const claims = decodeJwtClaims(captured.token);
    const capturedAt = source === 'preScript' ? readPreScriptValue<unknown>('graphCapturedAt') : undefined;
    return {
      source,
      present: true,
      expiresInSec: captured.exp - nowSec(),
      audience: audienceOf(claims),
      scopes: scopesOf(claims),
      fingerprint: tokenFingerprint(captured.token),
      capturedAgoSec: typeof capturedAt === 'number' ? Math.max(0, Math.round((Date.now() - capturedAt) / 1000)) : null,
    };
  });

export const isAuthenticated = (): boolean => getToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 8000 }).then(
    () => true,
    () => false,
  );

// --- Page identity ---

/** Origin of the current page — the only part of the URL that may appear in logs and tool output. */
export const pageOrigin = (): string => new URL(getCurrentUrl()).origin;

/** True when the current tab is a SharePoint/OneDrive-hosted Excel workbook. */
export const isSharePointWorkbook = (): boolean => {
  try {
    const url = new URL(getCurrentUrl());
    return url.hostname.endsWith('.sharepoint.com') && url.pathname.includes('/:x:/');
  } catch {
    return false;
  }
};

/**
 * The Office reload marker for this document: captured at document_start by
 * the pre-script (Office may strip the query afterwards), else parsed from the
 * current URL — the fallback for tabs that were open before the plugin
 * registered, whose pre-script never ran. Null when Office did not reload the
 * document.
 */
export const readReloadMarker = (): ReloadMarker | null =>
  readPreScriptValue<ReloadMarker>('reloadMarker') ?? parseReloadMarker(new URL(getCurrentUrl()).search, Date.now());

// --- Workbook context from URL ---

interface WorkbookContext {
  driveId: string;
  itemId: string;
}

/**
 * How a page URL identifies the open workbook: the standalone
 * `excel.cloud.microsoft` app carries `driveId`/`docId` in the query;
 * SharePoint/OneDrive-hosted workbooks identify the file by a sharing URL that
 * Graph `/shares` resolves to a drive item.
 */
export type WorkbookLocator = { kind: 'url'; driveId: string; itemId: string } | { kind: 'shares'; sharingUrl: string };

/** The workbook locator for `url`; null when the page is not a workbook. */
export const locateWorkbook = (url: URL): WorkbookLocator | null => {
  const driveId = url.searchParams.get('driveId');
  const docId = url.searchParams.get('docId');
  if (driveId && docId) return { kind: 'url', driveId, itemId: docId };
  if (url.hostname.endsWith('.sharepoint.com')) return { kind: 'shares', sharingUrl: url.href };
  return null;
};

/**
 * Per-tab cache keyed by the page URL. The Office apps are SPAs — same-tab
 * navigation to a different workbook changes `getCurrentUrl()` without
 * reloading the adapter, so a single-slot cache would silently return the
 * wrong drive/item. Comparing the URL on every read invalidates the cache
 * exactly when the workbook identity changes.
 */
let cached: { url: string; ctx: WorkbookContext } | null = null;

/** Encode a sharing URL into a Graph `/shares` share id (unpadded base64url with a `u!` prefix). */
const encodeShareId = (sharingUrl: string): string => {
  const bytes = new TextEncoder().encode(sharingUrl);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return `u!${base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
};

/**
 * Graph endpoint resolving a sharing URL to its drive item. The share id
 * encodes the whole sharing URL, so this endpoint never appears in logs or
 * tool output: `redactEndpoint` and `probeWorkbookShare` label it
 * `/shares/{shareId}/driveItem` instead.
 */
const shareDriveItemEndpoint = (sharingUrl: string): string => `/shares/${encodeShareId(sharingUrl)}/driveItem`;

/** Resolve the drive item behind a SharePoint/OneDrive sharing URL via Graph `/shares`. */
const resolveViaShares = async (sharingUrl: string): Promise<WorkbookContext> => {
  const item = await api<{ id?: string; parentReference?: { driveId?: string } }>(shareDriveItemEndpoint(sharingUrl), {
    query: { $select: 'id,parentReference' },
  });
  const driveId = item.parentReference?.driveId;
  if (!driveId || !item.id) {
    throw ToolError.notFound('Could not resolve the workbook from the current SharePoint URL.');
  }
  return { driveId, itemId: item.id };
};

/** Resolve the open workbook's drive and item ids. */
export const resolveWorkbookContext = async (): Promise<WorkbookContext> => {
  const currentUrl = getCurrentUrl();
  if (cached && cached.url === currentUrl) return cached.ctx;
  const locator = locateWorkbook(new URL(currentUrl));
  if (locator === null) {
    throw ToolError.validation('No workbook is currently open. Please open an Excel workbook in the browser first.');
  }
  const ctx =
    locator.kind === 'url'
      ? { driveId: locator.driveId, itemId: locator.itemId }
      : await resolveViaShares(locator.sharingUrl);
  cached = { url: currentUrl, ctx };
  return ctx;
};

// --- API caller ---

/**
 * Trailing guidance appended to AUTH_ERROR messages on SharePoint/OneDrive
 * pages. MSAL's encrypted cache means the token cannot be recovered in place —
 * the only reliable path is to clear MSAL state and reload, which the
 * `excel-online__reauthenticate` tool does.
 */
const SP_REAUTH_HINT = 'Call `excel-online__reauthenticate` to recover.';

const authError = (msg: string): ToolError => ToolError.auth(isSharePointWorkbook() ? `${msg} ${SP_REAUTH_HINT}` : msg);

export interface GraphRequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra request headers, e.g. a `Range` for a partial download. */
  headers?: Record<string, string>;
  /** Overrides the default 30s budget for endpoints that stream a whole file. */
  timeoutMs?: number;
  /**
   * The caller vouches that replaying this request after a transient failure
   * is safe even though its method (POST, PATCH, DELETE) is not idempotent by
   * default — e.g. writing fixed values to a range, clearing, merging, sorting
   * or applying a filter. GET is always replayed; set this only where a hidden
   * success followed by a replay leaves the workbook unchanged.
   */
  retryNonIdempotent?: boolean;
}

interface PreparedGraphRequest {
  url: string;
  init: RequestInit;
}

/**
 * Build the authenticated request for `endpoint`. Bearer auth only —
 * `credentials: 'omit'` keeps cookies away from graph.microsoft.com. The
 * timeout signal is shared by every attempt, so retries never extend the
 * caller's budget.
 */
const prepareGraphRequest = (endpoint: string, options: GraphRequestOptions): PreparedGraphRequest => {
  const token = getToken();
  if (token === null) throw authError('Not authenticated — please log in to Microsoft 365.');

  const qs = options.query ? buildQueryString(options.query) : '';
  const url = qs ? `${GRAPH_BASE}${endpoint}?${qs}` : `${GRAPH_BASE}${endpoint}`;
  const method = (options.method ?? 'GET').toUpperCase();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...options.headers,
  };

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  return {
    url,
    init: {
      method,
      headers,
      body,
      credentials: 'omit',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    },
  };
};

/**
 * The endpoint with its drive, item and share ids replaced by the placeholders
 * the probes use (`{driveId}`, `{itemId}`, `{shareId}`). Error messages carry
 * this form so they still name the workbook-relative resource — worksheet,
 * table, range — without the workbook's identity; a share id encodes the whole
 * sharing URL, so it is the most sensitive of the three.
 */
const redactEndpoint = (endpoint: string): string =>
  endpoint
    .replace(/\/drives\/[^/]+/g, '/drives/{driveId}')
    .replace(/\/items\/[^/]+/g, '/items/{itemId}')
    .replace(/\/shares\/[^/]+/g, '/shares/{shareId}');

/**
 * Audit-log details for a non-transient Graph failure: the HTTP status and,
 * when the upstream exposed one, its request id — never the endpoint.
 */
const responseErrorDetails = (response: Response, requestId: string | null): ToolErrorDetails =>
  requestId === null ? { httpStatus: response.status } : { httpStatus: response.status, requestId };

/**
 * Classify a non-ok Graph response into a ToolError. Transient statuses (408
 * and the retryable 5xx set) become UPSTREAM_UNAVAILABLE, whose message names
 * Microsoft's front door when it refused the request and reports `attempts`,
 * the number of requests fetchWithRetry actually sent; every other status
 * keeps its classification, names the redacted endpoint, gains the upstream
 * request id in its message when the response exposed one, and carries
 * `details: { httpStatus, requestId? }` for the audit log. Consumes the body.
 */
const classifyGraphFailure = async (response: Response, endpoint: string, attempts: number): Promise<ToolError> => {
  const { status } = response;
  if (status !== 429 && TRANSIENT_HTTP_STATUSES.has(status)) {
    return upstreamUnavailableError(response, { host: GRAPH_HOST, attempts });
  }

  const requestId = readUpstreamRequestId(response.headers);
  const requestIdText = requestId === null ? '' : ` (request-id ${requestId})`;
  const errorBody = (await response.text().catch(() => '')).substring(0, 512);
  const resource = redactEndpoint(endpoint);
  const details = responseErrorDetails(response, requestId);

  if (status === 401) return authError(`Auth error (401): ${errorBody}${requestIdText}`).withDetails(details);
  if (status === 403) return authError(`Forbidden (403): ${errorBody}${requestIdText}`).withDetails(details);
  if (status === 404) {
    return ToolError.notFound(`Not found: ${resource} — ${errorBody}${requestIdText}`).withDetails(details);
  }
  if (status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
    return ToolError.rateLimited(`Rate limited: ${resource} — ${errorBody}${requestIdText}`, retryMs).withDetails(
      details,
    );
  }
  if (status === 400 || status === 422) {
    return ToolError.validation(`Validation error: ${resource} — ${errorBody}${requestIdText}`).withDetails(details);
  }
  return ToolError.internal(`API error (${status}): ${resource} — ${errorBody}${requestIdText}`).withDetails(details);
};

/**
 * Issue an authenticated Graph request, retrying transient failures, and
 * classify what remains into `ToolError`s.
 *
 * GET is replayed on a network error or transient status up to
 * GRAPH_MAX_ATTEMPTS; other methods only when the caller sets `retryNonIdempotent` or
 * Microsoft's front door refused the request before forwarding it (the
 * `isFrontDoorRefusal` vouch). A rate limit whose Retry-After exceeds the
 * wrapper's wait ceiling surfaces as RATE_LIMITED with `retryAfterMs` so the
 * agent can wait instead of the tool.
 *
 * Returns the raw `Response` so callers can decode it as JSON, bytes, or
 * whatever the endpoint produces, without duplicating auth and error handling.
 */
const graphFetch = async (endpoint: string, options: GraphRequestOptions = {}): Promise<Response> => {
  const { url, init } = prepareGraphRequest(endpoint, options);
  const tracker = createAttemptTracker();

  let response: Response;
  try {
    response = await fetchWithRetry(url, init, {
      maxAttempts: GRAPH_MAX_ATTEMPTS,
      retryNonIdempotent: options.retryNonIdempotent === true,
      isTransient: isFrontDoorRefusal,
      onRetry: tracker.onRetry,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw ToolError.timeout(`API request timed out: ${redactEndpoint(endpoint)}`);
    }
    throw recodeFetchFailure(error, GRAPH_HOST, tracker.attempts());
  }

  if (!response.ok) throw await classifyGraphFailure(response, endpoint, tracker.attempts());
  return response;
};

export const api = async <T>(endpoint: string, options: GraphRequestOptions = {}): Promise<T> => {
  const response = await graphFetch(endpoint, options);
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};

/**
 * Download an endpoint's bytes.
 *
 * `range` takes an HTTP byte-range spec (e.g. `bytes=-65557` for a suffix). The
 * caller must tolerate the server ignoring it and returning 200 with the whole
 * body — `Content-Range` is not exposed to page scripts by Graph's CORS policy,
 * so the response's own length is the only reliable measure of what arrived.
 */
export const apiBytes = async (endpoint: string, options: { range?: string; timeoutMs?: number } = {}) => {
  const response = await graphFetch(endpoint, {
    headers: options.range ? { Range: options.range } : undefined,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    /** 206 means the server honoured the range; 200 means it returned everything. */
    isPartial: response.status === 206,
  };
};

// --- Diagnostics ---

/**
 * One un-retried, unclassified Graph request for the diagnose tool: the raw
 * status, latency, request id and front-door label of a single attempt. `path`
 * is the label recorded for the endpoint and must not carry an encoded share
 * id (use `probeWorkbookShare` for that endpoint).
 */
export const probeGraph = (
  name: string,
  path: string,
  endpoint: string,
  query?: Record<string, string>,
): Promise<ProbeResult> =>
  runProbe(name, path, () => {
    const { url, init } = prepareGraphRequest(endpoint, { query });
    return fetch(url, init);
  });

/** Probe of the `/shares` resolution for a SharePoint sharing URL, labelled without the encoded share id. */
export const probeWorkbookShare = (sharingUrl: string): Promise<ProbeResult> =>
  probeGraph('graph:/shares', '/shares/{shareId}/driveItem', shareDriveItemEndpoint(sharingUrl), { $select: 'id' });

// --- Workbook API helper ---

/** Workbook-relative resource path for a range within a worksheet (both URL-encoded). */
export const rangePath = (worksheet: string, address: string): string =>
  `/worksheets('${encodeURIComponent(worksheet)}')/range(address='${encodeURIComponent(address)}')`;

export const workbookApi = async <T>(path: string, options: GraphRequestOptions = {}): Promise<T> => {
  const endpoint = `${await workbookEndpointPrefix()}${path}`;
  return api<T>(endpoint, options);
};

const workbookEndpointPrefix = async (): Promise<string> => {
  const ctx = await resolveWorkbookContext();
  return `/drives/${ctx.driveId}/items/${encodeURIComponent(ctx.itemId)}/workbook`;
};

// --- Batched workbook writes ---

/** Graph rejects a `$batch` payload carrying more than this many sub-requests. */
const BATCH_LIMIT = 20;

/** One workbook-relative operation to run inside a `$batch` payload. */
export interface WorkbookBatchRequest {
  method: string;
  /** Workbook-relative path, e.g. `/worksheets('Sheet1')/range(address='B:B')/format`. */
  path: string;
  body?: unknown;
}

export interface WorkbookBatchOptions {
  /**
   * Whether every request in the batch — POST actions included — is safe to
   * replay after a transient failure. Threads into both the single-request
   * path and the `$batch` POST. The session-opening and session-closing POSTs
   * are not marked idempotent: they are replayed only when Microsoft's front
   * door vouches the request never reached the workbook (isFrontDoorRefusal);
   * a transient status from a later stage is never replayed, because a hidden
   * success would leave an orphaned session holding the edit lock.
   */
  retryNonIdempotent: boolean;
  onChunkComplete?: (completed: number, total: number) => void;
}

interface BatchResponse {
  responses?: { id?: string; status?: number; body?: { error?: { code?: string; message?: string } } }[];
}

/**
 * Open a persisted workbook session, or return null if one cannot be opened.
 *
 * A session is what makes a run of writes both fast and safe. Without one every
 * request independently acquires Excel's edit lock, opens the workbook, saves,
 * and closes: a dozen small edits take tens of seconds serialised, and running
 * them concurrently instead makes most of them fail with
 * `EditModeCannotAcquireLockTooManyRequests`. Inside a session the lock is held
 * once and the same run costs about two seconds.
 *
 * Failing to open one is not fatal — the caller still works sessionlessly, just
 * slower — so this degrades rather than throws. The POST is not marked
 * idempotent, so it is replayed only when Microsoft's front door vouches the
 * request never reached the workbook (isFrontDoorRefusal); a transient status
 * from a later stage is never replayed, because a replay after a hidden
 * success would leave an orphaned session holding the edit lock.
 */
const createWorkbookSession = async (prefix: string): Promise<string | null> => {
  try {
    const session = await api<{ id?: string }>(`${prefix}/createSession`, {
      method: 'POST',
      body: { persistChanges: true },
    });
    return session.id ?? null;
  } catch {
    return null;
  }
};

/**
 * Run several workbook operations through Microsoft Graph's `$batch` endpoint,
 * inside a single workbook session.
 *
 * Sub-requests are chained with `dependsOn` so the server applies them in the
 * caller's order. Ordering is cheap inside a session and keeps the helper safe
 * for callers whose operations are not independent.
 *
 * `$batch` answers 200 even when individual operations fail, so every
 * sub-response is inspected. Operations after a failure come back as Graph's
 * 424 Failed Dependency; those are reported as a skipped count rather than
 * mistaken for the original error.
 */
export const workbookBatch = async (
  requests: WorkbookBatchRequest[],
  options: WorkbookBatchOptions,
): Promise<number> => {
  if (requests.length === 0) return 0;

  const prefix = await workbookEndpointPrefix();
  const { retryNonIdempotent, onChunkComplete } = options;

  // A session costs a round trip to open, which is not worth it for a lone
  // operation that has no lock contention to avoid.
  const only = requests.length === 1 ? requests[0] : undefined;
  if (only) {
    await api(`${prefix}${only.path}`, { method: only.method, body: only.body, retryNonIdempotent });
    onChunkComplete?.(1, 1);
    return 1;
  }

  const sessionId = await createWorkbookSession(prefix);
  const sessionHeader = sessionId ? { 'workbook-session-id': sessionId } : {};
  let completed = 0;

  try {
    for (let start = 0; start < requests.length; start += BATCH_LIMIT) {
      const chunk = requests.slice(start, start + BATCH_LIMIT);
      const payload = {
        requests: chunk.map((request, index) => ({
          id: String(index + 1),
          method: request.method,
          url: `${prefix}${request.path}`,
          ...(index > 0 ? { dependsOn: [String(index)] } : {}),
          headers: {
            ...sessionHeader,
            ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(request.body !== undefined ? { body: request.body } : {}),
        })),
      };

      const result = await api<BatchResponse>('/$batch', { method: 'POST', body: payload, retryNonIdempotent });
      const responses = result.responses ?? [];

      const failure = responses
        .filter(response => (response.status ?? 200) >= 400 && response.status !== 424)
        .sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))[0];

      if (failure) {
        const index = Number(failure.id ?? 0) - 1;
        const skipped = responses.filter(response => response.status === 424).length;
        const detail = failure.body?.error?.message ?? failure.body?.error?.code ?? 'no detail';
        throw ToolError.internal(
          `Batched workbook operation failed on "${chunk[index]?.path ?? 'unknown'}" ` +
            `(${failure.status}): ${detail}. ${skipped} later operation(s) were skipped.`,
        );
      }

      completed += chunk.length;
      onChunkComplete?.(completed, requests.length);
    }
  } finally {
    if (sessionId) {
      await api(`${prefix}/closeSession`, { method: 'POST', headers: { 'workbook-session-id': sessionId } }).catch(
        () => {},
      );
    }
  }

  return completed;
};

// --- User API helper ---

export const getUserInfo = async (): Promise<{ displayName: string; mail: string; id: string }> => {
  return api('/me');
};
