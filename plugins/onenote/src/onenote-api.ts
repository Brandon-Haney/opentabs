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
import { tokenFingerprint } from './token-fingerprint.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const GRAPH_HOST = new URL(GRAPH_ORIGIN).host;

/** Attempts fetchWithRetry may spend on one Graph request, the first request included. */
const GRAPH_MAX_ATTEMPTS = 3;
/** Wall-clock budget for one Graph request across every retry attempt. */
const GRAPH_TIMEOUT_MS = 30_000;
/** Longest Graph error-envelope message quoted inside a classified ToolError. */
const MAX_ENVELOPE_MESSAGE_CHARS = 200;

// MSAL client ID used by the OneNote web app
const MSAL_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';
/** localStorage key the pre-script mirrors the captured Graph token to. */
const LS_TOKEN_KEY = '__opentabs_onenote_graph_token';
/** A captured token this close to its recorded expiry is treated as expired. */
const CAPTURED_EXPIRY_MARGIN_SEC = 30;

const SHAREPOINT_NO_NOTES_SCOPE_MESSAGE =
  'The OneNote Graph API is unavailable on SharePoint/OneDrive-hosted notebooks: the page grants Files/Sites permissions but no OneNote (Notes) scope. Use the "read_current_page" tool to read the open page, or open the notebook in the OneNote app (onenote.cloud.microsoft) to use the full OneNote API.';

const MAY_HAVE_CREATED_HINT =
  ' The request was not retried because a replay could duplicate the item; check whether it was created before trying again.';

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

/**
 * Where a Graph token can come from, in the order `getToken()` consults them:
 * the pre-script's in-page namespace, its localStorage mirror, then the
 * standalone app's plaintext MSAL cache.
 */
export const ONENOTE_TOKEN_SOURCES = ['preScriptNamespace', 'localStorageMirror', 'msalPlaintext'] as const;
export type OneNoteTokenSource = (typeof ONENOTE_TOKEN_SOURCES)[number];

interface TokenCandidate {
  source: OneNoteTokenSource;
  /** The raw access token, or null when the source holds none. */
  token: string | null;
  /** Unix epoch seconds the source records as the token's expiry; null when it records none. */
  expiresAt: number | null;
  /** Whether the source's own validity rule still accepts the token. */
  live: boolean;
}

/** What the diagnose tool reports about one token source — never the token itself. */
export interface TokenSourceDescription {
  source: OneNoteTokenSource;
  present: boolean;
  expiresInSec: number | null;
  /** Host of the token's `aud` claim (or the raw claim when it is not a URL). */
  audience: string | null;
  /** Last 4 hex characters of an FNV-1a hash of the token, to tell tokens apart across runs. */
  fingerprint: string | null;
  /** The token's `scp` claim, split into individual scopes. */
  scopes: string[];
  /** Whether the token carries a OneNote (Notes) scope, which the `/onenote` Graph endpoints require. */
  notesScope: boolean;
}

export interface TokenSourcesReport {
  sources: TokenSourceDescription[];
  /** The source `getToken()` selects right now; null when no source yields a usable token. */
  activeSource: OneNoteTokenSource | null;
}

/**
 * Read a value the pre-script stashed under the `onenote` namespace.
 *
 * `getPreScriptValue` depends on `globalThis.__openTabs._pluginName`, which the
 * adapter only binds during tool dispatch — so it returns `undefined` in
 * `isReady()`. We try the SDK helper first, then fall back to a direct read.
 */
const readPreScriptValue = <T>(key: string): T | undefined => {
  const viaSdk = getPreScriptValue<T>(key);
  if (viaSdk !== undefined) return viaSdk;
  const ns = (globalThis as { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } }).__openTabs
    ?.preScript?.onenote;
  return ns?.[key] as T | undefined;
};

const nowEpochSec = (): number => Math.floor(Date.now() / 1000);

const emptyCandidate = (source: OneNoteTokenSource): TokenCandidate => ({
  source,
  token: null,
  expiresAt: null,
  live: false,
});

/** A pre-script capture (namespace or localStorage mirror) is live only until CAPTURED_EXPIRY_MARGIN_SEC before its recorded expiry. */
const capturedCandidate = (
  source: OneNoteTokenSource,
  captured: CapturedGraphToken | undefined | null,
  nowSec: number,
): TokenCandidate => {
  const token = captured && typeof captured.token === 'string' && captured.token.length > 0 ? captured.token : null;
  const expiresAt = captured && typeof captured.exp === 'number' ? captured.exp : null;
  return {
    source,
    token,
    expiresAt,
    live: token !== null && expiresAt !== null && expiresAt > nowSec + CAPTURED_EXPIRY_MARGIN_SEC,
  };
};

const readLocalStorageMirror = (): CapturedGraphToken | null => {
  try {
    const raw = getLocalStorage(LS_TOKEN_KEY);
    return raw ? (JSON.parse(raw) as CapturedGraphToken) : null;
  } catch {
    return null;
  }
};

/**
 * A plaintext Graph access token from the standalone `onenote.cloud.microsoft`
 * app's MSAL localStorage cache, keyed by client id and scope. An entry with
 * no `expiresOn` is treated as live.
 */
const readMsalCandidate = (nowSec: number): TokenCandidate => {
  const none = emptyCandidate('msalPlaintext');
  const tokenKeysEntry = findLocalStorageEntry(key => key === `msal.token.keys.${MSAL_CLIENT_ID}`);
  if (!tokenKeysEntry) return none;

  let tokenKeys: { accessToken?: string[] };
  try {
    tokenKeys = JSON.parse(tokenKeysEntry.value);
  } catch {
    return none;
  }

  const graphKey = tokenKeys.accessToken?.find(
    k => /(?:^|[\s/])graph\.microsoft\.com(?:[/\s]|$)/.test(k) || k.includes('notes.create'),
  );
  if (!graphKey) return none;

  const entryStr = findLocalStorageEntry(key => key === graphKey);
  if (!entryStr) return none;

  let entry: { secret?: string; expiresOn?: string };
  try {
    entry = JSON.parse(entryStr.value);
  } catch {
    return none;
  }
  if (!entry.secret) return none;
  const expiresOn = Number(entry.expiresOn ?? 0);
  const expiresAt = expiresOn > 0 ? expiresOn : null;
  return { source: 'msalPlaintext', token: entry.secret, expiresAt, live: expiresAt === null || expiresAt >= nowSec };
};

/** Every token source in ONENOTE_TOKEN_SOURCES order, each judged against the same instant `nowSec`. */
const readTokenCandidates = (nowSec: number): TokenCandidate[] => [
  capturedCandidate('preScriptNamespace', readPreScriptValue<CapturedGraphToken>('graph'), nowSec),
  capturedCandidate('localStorageMirror', readLocalStorageMirror(), nowSec),
  readMsalCandidate(nowSec),
];

interface GraphTokenClaims {
  scp?: unknown;
  aud?: unknown;
}

/** The decoded JWT payload of a Graph access token, or {} if undecodable. */
const tokenClaims = (token: string): GraphTokenClaims => {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as GraphTokenClaims;
  } catch {
    return {};
  }
};

/** The space-delimited `scp` claim of a Graph access token, or '' if undecodable. */
const tokenScopes = (token: string): string => {
  const scp = tokenClaims(token).scp;
  return typeof scp === 'string' ? scp : '';
};

/** Whether a token carries an OneNote (Notes) scope — required by the `/onenote` Graph endpoints. */
const tokenHasNotesScope = (token: string): boolean => /(?:^|\s)(?:Notes\.|onenote\.)/i.test(tokenScopes(token));

/** Host of the token's `aud` claim; the raw claim when it is an application id rather than a URL. */
const tokenAudience = (token: string): string | null => {
  const aud = tokenClaims(token).aud;
  if (typeof aud !== 'string' || aud === '') return null;
  try {
    return new URL(aud).host;
  } catch {
    return aud;
  }
};

/**
 * Whether a candidate is the token `getToken()` hands out.
 *
 * A captured token must carry a Notes scope — on SharePoint/OneDrive-hosted
 * notebooks the page mints a Files/Sites token with no Notes scope, which the
 * `/onenote` endpoints reject. MSAL tokens come from the standalone OneNote
 * app, which requests Notes scopes, so they are trusted as-is.
 */
const acceptsForOneNote = (candidate: TokenCandidate): candidate is TokenCandidate & { token: string } =>
  candidate.live &&
  candidate.token !== null &&
  (candidate.source === 'msalPlaintext' || tokenHasNotesScope(candidate.token));

const selectCandidate = (candidates: TokenCandidate[]): (TokenCandidate & { token: string }) | undefined =>
  candidates.find(acceptsForOneNote);

/** A Graph token usable for the OneNote API, from the first accepted source in ONENOTE_TOKEN_SOURCES order. */
const getToken = (): string | null => selectCandidate(readTokenCandidates(nowEpochSec()))?.token ?? null;

const describeCandidate = (candidate: TokenCandidate, nowSec: number): TokenSourceDescription => ({
  source: candidate.source,
  present: candidate.token !== null,
  expiresInSec: candidate.expiresAt === null ? null : candidate.expiresAt - nowSec,
  audience: candidate.token === null ? null : tokenAudience(candidate.token),
  fingerprint: candidate.token === null ? null : tokenFingerprint(candidate.token),
  scopes: candidate.token === null ? [] : tokenScopes(candidate.token).split(/\s+/).filter(Boolean),
  notesScope: candidate.token !== null && tokenHasNotesScope(candidate.token),
});

/**
 * Describes every token source for the diagnose tool; `activeSource` is the
 * source `getToken()` would use. The clock is read once so each source's
 * liveness and its `expiresInSec` agree.
 */
export const describeTokenSources = (): TokenSourcesReport => {
  const nowSec = nowEpochSec();
  const candidates = readTokenCandidates(nowSec);
  return {
    sources: candidates.map(candidate => describeCandidate(candidate, nowSec)),
    activeSource: selectCandidate(candidates)?.source ?? null,
  };
};

export const isAuthenticated = (): boolean => getToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 8000 }).then(
    () => true,
    () => false,
  );

/**
 * Whether the current tab is a OneNote notebook.
 *
 * Accepts the standalone OneNote cloud app, SharePoint `:o:` short-link URLs,
 * and SharePoint `Doc.aspx` viewer URLs that reference a `.one` section file in
 * their `wd=target(...)` query (the form notebooks open in from Teams/links).
 */
export const isOneNoteTab = (): boolean => {
  const url = getCurrentUrl();
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Malformed URL — fall through to substring checks
  }
  if (host === 'onenote.cloud.microsoft') return true;
  if (/\/:o:\//i.test(url)) return true;
  // A `.one` section file referenced anywhere in the URL (path or query),
  // bounded so it does not match `.onenote`, `.online`, etc.
  if (/\.one\b/i.test(url)) return true;
  return false;
};

/** True when the current OneNote tab is SharePoint/OneDrive-hosted (token captured asynchronously). */
export const isSharePointNotebook = (): boolean => /\.sharepoint\.com/i.test(getCurrentUrl()) && isOneNoteTab();

export interface GraphRequestOptions {
  method?: string;
  /** A JSON object, sent as `application/json`; or a raw string, sent as `contentType` (default `text/html`). */
  body?: Record<string, unknown> | string;
  query?: Record<string, string | number | boolean | undefined>;
  contentType?: string;
}

type GraphQuery = GraphRequestOptions['query'];

const requireToken = (): string => {
  const token = getToken();
  if (token) return token;
  if (isSharePointNotebook()) throw ToolError.auth(SHAREPOINT_NO_NOTES_SCOPE_MESSAGE);
  throw ToolError.auth('Not authenticated — please log in to Microsoft OneNote.');
};

const graphUrl = (endpoint: string, query: GraphQuery): string => {
  const qs = query ? buildQueryString(query) : '';
  return qs ? `${GRAPH_BASE}${endpoint}?${qs}` : `${GRAPH_BASE}${endpoint}`;
};

const encodeRequest = (
  token: string,
  options: GraphRequestOptions,
): { headers: Record<string, string>; body: string | undefined } => {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (!options.body) return { headers, body: undefined };
  if (typeof options.body === 'string') {
    headers['Content-Type'] = options.contentType ?? 'text/html';
    return { headers, body: options.body };
  }
  headers['Content-Type'] = 'application/json';
  return { headers, body: JSON.stringify(options.body) };
};

/**
 * Every mutating request this plugin issues is a POST that creates a notebook,
 * section, section group or page. One that failed without a front-door refusal
 * may still have been applied by Graph, so its error carries a hint to check
 * before replaying; a refused request never reached Graph.
 */
const mayHaveCreatedItem = (response: Response, method: string): boolean =>
  method === 'POST' && !isFrontDoorRefusal(response);

/** True for a non-ok response fetchWithRetry gave up on: a transient status or a front-door refusal. */
const isExhaustedTransient = (response: Response): boolean =>
  !response.ok && (TRANSIENT_HTTP_STATUSES.has(response.status) || isFrontDoorRefusal(response));

/**
 * Builds the UPSTREAM_UNAVAILABLE error for a transient failure that survived
 * (or was excluded from) retrying, naming the number of requests actually sent.
 * The duplicate hint changes only the message; code, category, retry fields
 * and audit details are preserved.
 */
const upstreamFailure = async (response: Response, method: string, attempts: number): Promise<ToolError> => {
  const error = await upstreamUnavailableError(response, { host: GRAPH_HOST, attempts });
  if (!mayHaveCreatedItem(response, method)) return error;
  return new ToolError(`${error.message}${MAY_HAVE_CREATED_HINT}`, error.code, {
    category: error.category,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    details: error.details,
  });
};

/**
 * Issues one Graph request through fetchWithRetry. GET requests are replayed
 * on transient statuses and network errors; the POST creates this plugin
 * issues are replayed only when Microsoft's front door refused the request
 * before forwarding it (isFrontDoorRefusal), because a replayed create would
 * duplicate the notebook, section or page. Bearer auth, so cookies are never
 * sent. The timeout signal spans every attempt; its TimeoutError surfaces as
 * TIMEOUT, fetchWithRetry's own failures as NETWORK_ERROR / ABORTED, and a
 * transient status or front-door refusal it gave up on as UPSTREAM_UNAVAILABLE.
 * Each of those messages reports the attempt count observed through
 * fetchWithRetry's `onRetry` callback. A 429 and every other non-ok status
 * come back as the Response for `classifyGraphFailure`. `resource` is the
 * redacted endpoint label the timeout message names.
 */
const sendGraphRequest = async (url: string, init: RequestInit, resource: string): Promise<Response> => {
  const tracker = createAttemptTracker();
  const method = init.method ?? 'GET';

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      { ...init, credentials: 'omit', signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) },
      { maxAttempts: GRAPH_MAX_ATTEMPTS, isTransient: isFrontDoorRefusal, onRetry: tracker.onRetry },
    );
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw ToolError.timeout(`API request timed out: ${resource}`);
    throw recodeFetchFailure(error, GRAPH_HOST, tracker.attempts());
  }

  if (response.status !== 429 && isExhaustedTransient(response)) {
    throw await upstreamFailure(response, method, tracker.attempts());
  }
  return response;
};

/**
 * The endpoint with every notebook, section, section group and page id
 * replaced by `{id}`, for error messages and therefore the audit log. The
 * `getRecentNotebooks(...)` function segment carries no id and is kept.
 */
const redactEndpoint = (endpoint: string): string =>
  endpoint.replace(/\/(notebooks|sections|sectionGroups|pages)\/(?!\w+\()[^/]+/g, '/$1/{id}');

interface GraphErrorEnvelope {
  code: string | null;
  message: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const nonEmptyString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Reads the `{ error: { code, message } }` envelope Graph returns with a JSON
 * content type; the one body read `classifyGraphFailure` performs. Null when
 * the body is not JSON, does not parse, or carries neither field. A non-JSON
 * body is never quoted.
 */
const readGraphErrorEnvelope = async (response: Response): Promise<GraphErrorEnvelope | null> => {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const code = nonEmptyString(parsed.error.code);
  const message = nonEmptyString(parsed.error.message);
  return code === null && message === null ? null : { code, message };
};

const truncate = (text: string): string =>
  text.length > MAX_ENVELOPE_MESSAGE_CHARS ? `${text.slice(0, MAX_ENVELOPE_MESSAGE_CHARS - 1)}…` : text;

/** ` — <code>: <message>` for a present envelope, empty otherwise. */
const envelopeText = (envelope: GraphErrorEnvelope | null): string => {
  if (envelope === null) return '';
  const parts = [envelope.code, envelope.message === null ? null : truncate(envelope.message)];
  return ` — ${parts.filter(part => part !== null).join(': ')}`;
};

/**
 * Audit-log details for a ToolError classified from a Graph response: the
 * HTTP status and, when the upstream exposed one, its request id — never the
 * endpoint.
 */
const responseErrorDetails = (status: number, requestId: string | null): ToolErrorDetails =>
  requestId === null ? { httpStatus: status } : { httpStatus: status, requestId };

/**
 * Maps a non-ok Graph response `sendGraphRequest` handed back to the ToolError
 * `api()` throws. Messages name the redacted `resource` (never the endpoint,
 * whose ids would otherwise reach the audit log), quote the JSON error
 * envelope when there is one, and end with the upstream request id when the
 * response exposed one; `details` carries the status and request id for the
 * audit log. Consumes the body.
 */
const classifyGraphFailure = async (response: Response, resource: string): Promise<ToolError> => {
  const { status, headers } = response;
  const detail = envelopeText(await readGraphErrorEnvelope(response));
  const requestId = readUpstreamRequestId(headers);
  const requestIdText = requestId === null ? '' : ` (request-id ${requestId})`;
  const details = responseErrorDetails(status, requestId);

  if (status === 429) {
    const retryAfter = headers.get('Retry-After');
    const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
    return ToolError.rateLimited(`Rate limited: ${resource}${detail}${requestIdText}`, retryMs).withDetails(details);
  }
  if (status === 401 || status === 403) {
    return ToolError.auth(`Auth error (${status})${detail}${requestIdText}`).withDetails(details);
  }
  if (status === 404) return ToolError.notFound(`Not found: ${resource}${detail}${requestIdText}`).withDetails(details);
  if (status === 400 || status === 422) {
    return ToolError.validation(`Validation error: ${resource}${detail}${requestIdText}`).withDetails(details);
  }
  return ToolError.internal(`API error (${status}): ${resource}${detail}${requestIdText}`).withDetails(details);
};

/**
 * Calls the Microsoft Graph API for OneNote operations with the token from
 * `getToken()`. Every request goes through `sendGraphRequest`, so transient
 * failures are retried where safe and classified as UPSTREAM_UNAVAILABLE /
 * NETWORK_ERROR once exhausted.
 */
export const api = async <T>(endpoint: string, options: GraphRequestOptions = {}): Promise<T> => {
  const token = requireToken();
  const method = (options.method ?? 'GET').toUpperCase();
  const { headers, body } = encodeRequest(token, options);
  const resource = redactEndpoint(endpoint);

  const response = await sendGraphRequest(graphUrl(endpoint, options.query), { method, headers, body }, resource);
  if (!response.ok) throw await classifyGraphFailure(response, resource);

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};

/**
 * Single-attempt GET against Graph for the diagnose tool. Bypasses
 * fetchWithRetry so the result shows raw upstream behavior; without a
 * Notes-scoped token no request is made. `path` is reported verbatim, so pass
 * a literal endpoint that carries no item id.
 */
export const probeGraph = async (name: string, path: string, query?: GraphQuery): Promise<ProbeResult> => {
  const token = getToken();
  if (token === null) {
    return {
      name,
      path,
      status: null,
      ok: false,
      latencyMs: 0,
      requestId: null,
      frontDoor: null,
      error: 'no Notes-scoped token',
    };
  }
  return runProbe(name, path, () =>
    fetch(graphUrl(path, query), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    }),
  );
};
