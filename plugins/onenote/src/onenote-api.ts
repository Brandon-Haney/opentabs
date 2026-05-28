import {
  ToolError,
  buildQueryString,
  findLocalStorageEntry,
  getCurrentUrl,
  getLocalStorage,
  getPreScriptValue,
  parseRetryAfterMs,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// MSAL client ID used by the OneNote web app
const MSAL_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';
/** localStorage key the pre-script mirrors the captured Graph token to. */
const LS_TOKEN_KEY = '__opentabs_onenote_graph_token';

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
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

const usableToken = (captured: CapturedGraphToken | undefined | null): string | null => {
  if (!captured || typeof captured.token !== 'string' || captured.token.length === 0) return null;
  if (typeof captured.exp !== 'number' || captured.exp <= Math.floor(Date.now() / 1000) + 30) return null;
  return captured.token;
};

/** The Graph token captured by the pre-script (in-page namespace, then localStorage mirror). */
const getCapturedToken = (): string | null => {
  const fromNamespace = usableToken(readPreScriptValue<CapturedGraphToken>('graph'));
  if (fromNamespace) return fromNamespace;
  try {
    const raw = getLocalStorage(LS_TOKEN_KEY);
    if (raw) return usableToken(JSON.parse(raw) as CapturedGraphToken);
  } catch {
    /* malformed or inaccessible — fall through */
  }
  return null;
};

/**
 * A plaintext Graph access token from the standalone `onenote.cloud.microsoft`
 * app's MSAL localStorage cache, keyed by client id and scope.
 */
const getMsalToken = (): string | null => {
  const tokenKeysEntry = findLocalStorageEntry(key => key === `msal.token.keys.${MSAL_CLIENT_ID}`);
  if (!tokenKeysEntry) return null;

  let tokenKeys: { accessToken?: string[] };
  try {
    tokenKeys = JSON.parse(tokenKeysEntry.value);
  } catch {
    return null;
  }

  const graphKey = tokenKeys.accessToken?.find(
    k => /(?:^|[\s/])graph\.microsoft\.com(?:[/\s]|$)/.test(k) || k.includes('notes.create'),
  );
  if (!graphKey) return null;

  const entryStr = findLocalStorageEntry(key => key === graphKey);
  if (!entryStr) return null;

  let entry: { secret?: string; expiresOn?: string };
  try {
    entry = JSON.parse(entryStr.value);
  } catch {
    return null;
  }
  if (!entry.secret) return null;
  const expiresOn = Number(entry.expiresOn ?? 0);
  if (expiresOn > 0 && expiresOn < Math.floor(Date.now() / 1000)) return null;
  return entry.secret;
};

/** The space-delimited `scp` claim of a Graph access token, or '' if undecodable. */
const tokenScopes = (token: string): string => {
  try {
    const part = token.split('.')[1];
    if (!part) return '';
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { scp?: string };
    return typeof payload.scp === 'string' ? payload.scp : '';
  } catch {
    return '';
  }
};

/** Whether a token carries an OneNote (Notes) scope — required by the `/onenote` Graph endpoints. */
const tokenHasNotesScope = (token: string): boolean => /(?:^|\s)(?:Notes\.|onenote\.)/i.test(tokenScopes(token));

/**
 * A Graph token usable for the OneNote API.
 *
 * The captured token must carry a Notes scope to be usable — on
 * SharePoint/OneDrive-hosted notebooks the page mints a Files/Sites token with
 * no Notes scope, which the `/onenote` endpoints reject. MSAL tokens come from
 * the standalone OneNote app, which requests Notes scopes, so they are trusted
 * as-is.
 */
const getToken = (): string | null => {
  const captured = getCapturedToken();
  if (captured && tokenHasNotesScope(captured)) return captured;
  return getMsalToken();
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

/**
 * Calls the Microsoft Graph API for OneNote operations.
 * Auth is via MSAL bearer tokens extracted from localStorage.
 */
export const api = async <T>(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown> | string;
    query?: Record<string, string | number | boolean | undefined>;
    contentType?: string;
  } = {},
): Promise<T> => {
  const token = getToken();
  if (!token) {
    if (isSharePointNotebook()) {
      throw ToolError.auth(
        'The OneNote Graph API is unavailable on SharePoint/OneDrive-hosted notebooks: the page grants Files/Sites permissions but no OneNote (Notes) scope. Use the "read_current_page" tool to read the open page, or open the notebook in the OneNote app (onenote.cloud.microsoft) to use the full OneNote API.',
      );
    }
    throw ToolError.auth('Not authenticated — please log in to Microsoft OneNote.');
  }

  const qs = options.query ? buildQueryString(options.query) : '';
  const url = qs ? `${GRAPH_BASE}${endpoint}?${qs}` : `${GRAPH_BASE}${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let fetchBody: string | undefined;
  if (options.body) {
    if (typeof options.body === 'string') {
      headers['Content-Type'] = options.contentType ?? 'text/html';
      fetchBody = options.body;
    } else {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(options.body);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw ToolError.timeout(`API request timed out: ${endpoint}`);
    if (err instanceof DOMException && err.name === 'AbortError') throw new ToolError('Request was aborted', 'aborted');
    throw new ToolError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'network_error', {
      category: 'internal',
      retryable: true,
    });
  }

  if (!response.ok) {
    const errorBody = (await response.text().catch(() => '')).substring(0, 512);

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
      throw ToolError.rateLimited(`Rate limited: ${endpoint} — ${errorBody}`, retryMs);
    }
    if (response.status === 401 || response.status === 403) {
      throw ToolError.auth(`Auth error (${response.status}): ${errorBody}`);
    }
    if (response.status === 404) throw ToolError.notFound(`Not found: ${endpoint} — ${errorBody}`);
    if (response.status === 400 || response.status === 422)
      throw ToolError.validation(`Validation error: ${endpoint} — ${errorBody}`);
    throw ToolError.internal(`API error (${response.status}): ${endpoint} — ${errorBody}`);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};
