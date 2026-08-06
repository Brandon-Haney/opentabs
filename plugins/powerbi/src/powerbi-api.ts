import {
  ToolError,
  buildQueryString,
  clearAuthCache,
  fetchFromPage,
  getAuthCache,
  getPageGlobal,
  getSessionStorage,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

const API_BASE = 'https://api.powerbi.com/v1.0/myorg';

/**
 * Audience a token must carry to be accepted by the Power BI REST API. A
 * Microsoft Graph token does not work here and vice versa — they are separate
 * resources, so a token is only usable if this exact audience is in its claims.
 */
const POWER_BI_AUDIENCE = 'https://analysis.windows.net/powerbi/api';

/** Namespace the resolved token is cached under, so it survives adapter re-injection. */
const AUTH_NAMESPACE = 'powerbi';

/** Seconds of headroom required before a token is considered usable. */
const EXPIRY_SKEW_SECONDS = 60;

interface PowerBiAuth {
  token: string;
  /** Unix epoch seconds, read from the token's own `exp` claim. */
  exp: number;
}

interface JwtClaims {
  aud?: string;
  exp?: number;
}

/**
 * Decode a JWT's payload claims. Signature is neither checked nor needed — the
 * service validates it; we only read `aud` and `exp` to pick a usable token.
 */
const decodeJwtClaims = (token: string): JwtClaims | null => {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const payload = segments[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as JwtClaims;
  } catch {
    return null;
  }
};

const isLive = (exp: number): boolean => exp > Math.floor(Date.now() / 1000) + EXPIRY_SKEW_SECONDS;

/** Accept a token only if it is a live JWT for the Power BI audience. */
const toAuth = (token: unknown): PowerBiAuth | null => {
  if (typeof token !== 'string' || token.length === 0) return null;
  const claims = decodeJwtClaims(token);
  if (!claims || claims.aud !== POWER_BI_AUDIENCE || typeof claims.exp !== 'number') return null;
  return isLive(claims.exp) ? { token, exp: claims.exp } : null;
};

/**
 * Find a session-storage entry by key predicate.
 *
 * The SDK ships `findLocalStorageEntry` but has no session-storage equivalent,
 * and Power BI's MSAL instance is configured with `sessionStorage` as its cache
 * location, so the scan has to be done here.
 */
const findSessionStorageEntry = (predicate: (key: string) => boolean): string | null => {
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key !== null && predicate(key)) {
        const value = getSessionStorage(key);
        if (value !== null) return value;
      }
    }
  } catch {
    /* storage unavailable — treat as no match */
  }
  return null;
};

/**
 * The token Power BI's own web client holds. This is the cheapest source and
 * the one the app keeps refreshed while the tab is open.
 */
const fromPageGlobal = (): PowerBiAuth | null => toAuth(getPageGlobal('powerBIAccessToken'));

/**
 * MSAL's token cache, used when the page global is missing or stale.
 *
 * MSAL v2 writes flat keys of the form
 * `msal.<ver>|<homeAccountId>|<environment>|accesstoken|<clientId>|<tenant>|<scopes>`
 * with the raw token in a `secret` field. Entries are matched by audience
 * rather than by client id, so this does not depend on which first-party
 * application minted the token.
 */
const fromMsalCache = (): PowerBiAuth | null => {
  const raw = findSessionStorageEntry(key => key.toLowerCase().includes('accesstoken'));
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw) as { secret?: unknown };
    return toAuth(entry.secret);
  } catch {
    return null;
  }
};

const getAuth = (): PowerBiAuth | null => {
  const cached = getAuthCache<PowerBiAuth>(AUTH_NAMESPACE);
  if (cached && isLive(cached.exp)) return cached;

  const resolved = fromPageGlobal() ?? fromMsalCache();
  if (resolved) setAuthCache(AUTH_NAMESPACE, resolved);
  return resolved;
};

export const isAuthenticated = (): boolean => getAuth() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 8000 }).then(
    () => true,
    () => false,
  );

// --- API caller ---

export interface PowerBiListResponse<T> {
  value?: T[];
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * Call the Power BI REST API with the browser session's own token.
 *
 * `credentials: 'omit'` is deliberate: `api.powerbi.com` is a different origin
 * from the app and authenticates by bearer token, so sending cookies would add
 * nothing and only risks a CORS rejection.
 *
 * `fetchFromPage` classifies HTTP failures into `ToolError`s and truncates error
 * bodies to 512 characters before they reach any message, which keeps query
 * results and model detail out of logs.
 */
export const api = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const auth = getAuth();
  if (!auth) {
    throw ToolError.auth(
      'Not authenticated with Power BI. Open and sign in to app.powerbi.com in this tab, then retry.',
    );
  }

  const qs = options.query ? buildQueryString(options.query) : '';
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;

  const headers: Record<string, string> = { Authorization: `Bearer ${auth.token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetchFromPage(url, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'omit',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    // A rejected token is worth discarding so the next call re-reads a fresh
    // one; anything else leaves the cache alone.
    if (error instanceof ToolError && error.code === 'auth_error') clearAuthCache(AUTH_NAMESPACE);
    throw error;
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};
