import {
  ToolError,
  buildQueryString,
  clearAuthCache,
  findLocalStorageEntry,
  getAuthCache,
  getLocalStorage,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';
import type { FetchFromPageOptions } from '@opentabs-dev/plugin-sdk';

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const OUTLOOK_API_BASE = 'https://outlook.office.com/api/v2.0';

// Outlook enterprise MSAL client ID
const MSAL_CLIENT_ID = '9199bf20-a13f-4107-85dc-02114787ef48';
// Consumer fallback
const MSAL_CLIENT_ID_CONSUMER = '2821b473-fe24-4c86-ba16-62834d6e80c3';

interface OutlookAuth {
  token: string;
  apiBase: string; // which API base URL this token works with
}

/**
 * A token capability. Mail and calendar require different Microsoft Graph scopes,
 * and a token granted for one is not guaranteed to carry the other — enterprise
 * tenants commonly issue a narrowly-scoped Graph token (User.Read only) alongside
 * a broad Outlook REST token. Calendar read and write are kept separate so mutating
 * tools never bind to a read-only calendar token (which would 403 at request time and
 * surface as a misleading "authentication expired"). Each capability resolves against
 * its own scope set and caches independently.
 */
type Capability = 'mail' | 'calendar' | 'calendar-write';

/** Scopes that satisfy each capability. A usable token must include at least one. */
const CAPABILITY_SCOPES: Record<Capability, string[]> = {
  mail: ['mail.read', 'mail.readwrite', 'mail.send'],
  calendar: ['calendars.read', 'calendars.readwrite'],
  'calendar-write': ['calendars.readwrite'],
};

/** Per-capability auth cache key, keeping each token bucket separate. */
const AUTH_CACHE_KEY: Record<Capability, string> = {
  mail: 'outlook',
  calendar: 'outlook-calendar',
  'calendar-write': 'outlook-calendar-write',
};

/**
 * Check whether a token's target scopes satisfy the given capability.
 */
const hasCapabilityScope = (target: string, capability: Capability): boolean => {
  const lower = target.toLowerCase();
  return CAPABILITY_SCOPES[capability].some(scope => lower.includes(scope));
};

/**
 * Search MSAL v2 token cache for a valid access token matching a target scope pattern
 * and carrying the requested capability's scope. Some enterprise tenants issue tokens
 * (Graph or REST) scoped for one capability but not another — e.g. a Graph token with
 * only User.Read that 403s on mail endpoints, or a token without Calendars.* — so every
 * candidate is verified against the capability scope before being accepted.
 */
const findMsalV2Token = (clientId: string, scopeMatch: string, capability: Capability): OutlookAuth | null => {
  const tokenKeysRaw = getLocalStorage(`msal.2.token.keys.${clientId}`);
  if (!tokenKeysRaw) return null;

  let tokenKeys: { accessToken?: string[] };
  try {
    tokenKeys = JSON.parse(tokenKeysRaw);
  } catch {
    return null;
  }
  if (!tokenKeys.accessToken) return null;

  for (const key of tokenKeys.accessToken) {
    const raw = getLocalStorage(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.secret) continue;

      const target: string = parsed.target ?? '';
      const matches = target.toLowerCase().includes(scopeMatch) || key.toLowerCase().includes(scopeMatch);
      if (!matches) continue;

      const expiresOn = Number(parsed.expiresOn);
      if (!Number.isInteger(expiresOn) || expiresOn <= 0 || expiresOn * 1000 < Date.now()) continue;

      if (!hasCapabilityScope(target, capability)) continue;

      const apiBase = scopeMatch === 'graph.microsoft.com' ? GRAPH_API_BASE : OUTLOOK_API_BASE;
      return { token: parsed.secret, apiBase };
    } catch {
      // skip invalid entries
    }
  }
  return null;
};

/**
 * Search the MSAL v3 token cache for a valid access token matching a target scope
 * pattern and carrying the requested capability's scope.
 *
 * MSAL v3 abandons the `msal.2.token.keys.<clientId>` index used by v2. Each access
 * token is instead stored under a flat, pipe-delimited key of the form
 * `msal.3|<homeAccountId>|<environment>|accesstoken|<clientId>|<tenant>|<scopes>|`
 * with the entity JSON (containing `secret`, `target`, `expiresOn`) as the value.
 * Tokens are located by scanning localStorage keys directly rather than via an index.
 */
const findMsalV3Token = (scopeMatch: string, capability: Capability): OutlookAuth | null => {
  const entry = findLocalStorageEntry(key => {
    const lower = key.toLowerCase();
    if (!lower.startsWith('msal.3|') || !lower.includes('|accesstoken|')) return false;
    if (!lower.includes(scopeMatch)) return false;

    const raw = getLocalStorage(key);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.secret) return false;

      const expiresOn = Number(parsed.expiresOn);
      if (!Number.isInteger(expiresOn) || expiresOn <= 0 || expiresOn * 1000 < Date.now()) return false;

      return hasCapabilityScope(parsed.target ?? '', capability);
    } catch {
      return false;
    }
  });
  if (!entry) return null;

  try {
    const parsed = JSON.parse(entry.value);
    const apiBase = scopeMatch === 'graph.microsoft.com' ? GRAPH_API_BASE : OUTLOOK_API_BASE;
    return { token: parsed.secret, apiBase };
  } catch {
    return null;
  }
};

/**
 * Search MSAL v1 token cache for a valid Graph API access token carrying the
 * requested capability's scope.
 */
const findMsalV1Token = (clientId: string, capability: Capability): OutlookAuth | null => {
  const tokenKeysRaw = getLocalStorage(`msal.token.keys.${clientId}`);
  if (!tokenKeysRaw) return null;

  let tokenKeys: { accessToken?: string[] };
  try {
    tokenKeys = JSON.parse(tokenKeysRaw);
  } catch {
    return null;
  }
  if (!tokenKeys.accessToken) return null;

  for (const key of tokenKeys.accessToken) {
    if (!/(?:^|[\s/])graph\.microsoft\.com(?:[/\s]|$)/.test(key)) continue;
    const raw = getLocalStorage(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.secret) continue;
      const expiresOn = Number(parsed.expiresOn);
      if (!Number.isInteger(expiresOn) || expiresOn <= 0 || expiresOn * 1000 < Date.now()) continue;
      if (!hasCapabilityScope(parsed.target ?? '', capability)) continue;
      return { token: parsed.secret, apiBase: GRAPH_API_BASE };
    } catch {
      // skip invalid entries
    }
  }
  return null;
};

/**
 * Extract a valid access token for the given capability from the MSAL localStorage cache.
 * Priority: Graph API token > Outlook REST API token.
 * Supports MSAL v2 (enterprise) and v1 (consumer) formats.
 */
const getAuth = (capability: Capability): OutlookAuth | null => {
  const cacheKey = AUTH_CACHE_KEY[capability];
  const cached = getAuthCache<OutlookAuth>(cacheKey);
  if (cached) return cached;

  // 1. MSAL v3 — Graph API token (current cache schema on outlook.cloud.microsoft)
  let auth = findMsalV3Token('graph.microsoft.com', capability);

  // 2. MSAL v3 — Outlook REST API token
  if (!auth) auth = findMsalV3Token('outlook.office.com', capability);

  // 3. Enterprise MSAL v2 — Graph API token
  if (!auth) auth = findMsalV2Token(MSAL_CLIENT_ID, 'graph.microsoft.com', capability);

  // 4. Enterprise MSAL v2 — Outlook REST API token
  if (!auth) auth = findMsalV2Token(MSAL_CLIENT_ID, 'outlook.office.com', capability);

  // 5. Consumer MSAL v1 — Graph API token
  if (!auth) auth = findMsalV1Token(MSAL_CLIENT_ID_CONSUMER, capability);

  // 6. Fallback: scan for any MSAL v2 entry with Graph scope
  if (!auth) {
    const entry = findLocalStorageEntry(key => key.startsWith('msal.2.token.keys.'));
    if (entry) {
      const cid = entry.key.replace('msal.2.token.keys.', '');
      auth = findMsalV2Token(cid, 'graph.microsoft.com', capability);
      if (!auth) auth = findMsalV2Token(cid, 'outlook.office.com', capability);
    }
  }

  // 7. Fallback: scan for any MSAL v1 entry
  if (!auth) {
    const entry = findLocalStorageEntry(key => key.startsWith('msal.token.keys.'));
    if (entry) {
      const cid = entry.key.replace('msal.token.keys.', '');
      auth = findMsalV1Token(cid, capability);
    }
  }

  if (auth) setAuthCache(cacheKey, auth);
  return auth;
};

export const isAuthenticated = (): boolean => getAuth('mail') !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

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

/**
 * Send an authenticated request and handle the response.
 * Returns the parsed response or throws on error.
 * On 401/403, returns `null` to signal the caller to retry with a fresh token.
 */
const sendRequest = async <T>(
  auth: OutlookAuth,
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
  },
): Promise<T | null> => {
  const isOutlookApi = auth.apiBase === OUTLOOK_API_BASE;

  // Outlook REST API uses different $select field names, so drop $select
  // and let it return all fields. The normalizeKeys step handles casing.
  const query = options.query ? { ...options.query } : undefined;
  if (isOutlookApi && query) {
    delete (query as Record<string, unknown>).$select;
  }

  const qs = query ? buildQueryString(query) : '';
  const url = qs ? `${auth.apiBase}${endpoint}?${qs}` : `${auth.apiBase}${endpoint}`;
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    ...options.headers,
  };

  const init: FetchFromPageOptions = { method, headers };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
    const body = isOutlookApi ? pascalCaseKeys(options.body) : options.body;
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'omit',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw ToolError.timeout('Microsoft API request timed out.');
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ToolError('Request aborted', 'aborted');
    }
    throw new ToolError(`Network error: ${err instanceof Error ? err.message : 'unknown'}`, 'network_error', {
      category: 'internal',
      retryable: true,
    });
  }

  if (response.status === 204) return {} as T;

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const retryMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : undefined;
    throw ToolError.rateLimited('Microsoft API rate limit exceeded.', retryMs);
  }

  // Signal caller to retry with a fresh token
  if (response.status === 401 || response.status === 403) return null;

  if (response.status === 404) {
    throw ToolError.notFound('The requested resource was not found.');
  }

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
    if (response.status === 400 || response.status === 422) {
      throw ToolError.validation(errorMsg);
    }
    throw ToolError.internal(errorMsg);
  }

  // Successful actions (cancel, RSVP, sendMail) often return 202/205 or a 200 with
  // an empty body and no JSON. Only parse when the response actually carries JSON.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return {} as T;

  const json = await response.json();
  return (isOutlookApi ? normalizeKeys(json) : json) as T;
};

/**
 * Make an authenticated request to a Microsoft 365 API for the given capability.
 * Mail requests default to the `mail` capability; calendar tools pass `calendar`
 * so they resolve a calendar-scoped token instead of inheriting a mail-only one.
 * Automatically uses whichever API the resolved token supports (Graph or Outlook REST).
 * On 401/403, clears the cached token, re-acquires from MSAL localStorage, and retries once.
 */
export const api = async <T>(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
  } = {},
  capability: Capability = 'mail',
): Promise<T> => {
  const cacheKey = AUTH_CACHE_KEY[capability];
  let auth = getAuth(capability);
  if (!auth) throw ToolError.auth('Not authenticated — please sign in to Microsoft 365.');

  const result = await sendRequest<T>(auth, endpoint, options);
  if (result !== null) return result;

  // 401/403 — clear stale cache, re-acquire token from MSAL, and retry once
  clearAuthCache(cacheKey);
  auth = getAuth(capability);
  if (!auth) throw ToolError.auth('Authentication expired — please refresh the Outlook page.');

  const retry = await sendRequest<T>(auth, endpoint, options);
  if (retry !== null) return retry;

  clearAuthCache(cacheKey);
  throw ToolError.auth('Authentication expired — please refresh the Outlook page.');
};
