import { ToolError } from '@opentabs-dev/plugin-sdk';

interface DiscordAuth {
  token: string;
}

/**
 * Discord deletes `window.localStorage` from the main frame but the underlying
 * storage is still accessible via a temporary same-origin iframe. This function
 * creates a hidden iframe, reads the value, and removes the iframe.
 */
const readLocalStorage = (key: string): string | null => {
  // Fast path: localStorage is directly available
  if (typeof window.localStorage !== 'undefined' && window.localStorage !== null) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      // Fall through to iframe approach
    }
  }

  // Iframe approach: Discord removes window.localStorage but same-origin iframes retain access
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  try {
    const storage = iframe.contentWindow?.localStorage;
    if (!storage) return null;
    return storage.getItem(key);
  } catch {
    return null;
  } finally {
    document.body.removeChild(iframe);
  }
};

/**
 * Persistent token cache stored on `globalThis.__openTabs` so it survives
 * adapter re-injection (extension reloads re-execute the IIFE, which creates
 * new module-level variables — but globalThis persists across injections).
 */
const getPersistedToken = (): string | null => {
  try {
    const ns = (globalThis as Record<string, unknown>).__openTabs as Record<string, unknown> | undefined;
    const cache = ns?.tokenCache as Record<string, string | undefined> | undefined;
    return cache?.discord ?? null;
  } catch {
    return null;
  }
};

const setPersistedToken = (token: string): void => {
  try {
    const g = globalThis as Record<string, unknown>;
    if (!g.__openTabs) g.__openTabs = {};
    const ns = g.__openTabs as Record<string, unknown>;
    if (!ns.tokenCache) ns.tokenCache = {};
    const cache = ns.tokenCache as Record<string, string | undefined>;
    cache.discord = token;
  } catch {
    // globalThis access failed — nothing to persist
  }
};

const clearPersistedToken = (): void => {
  try {
    const ns = (globalThis as Record<string, unknown>).__openTabs as Record<string, unknown> | undefined;
    const cache = ns?.tokenCache as Record<string, string | undefined> | undefined;
    if (cache) cache.discord = undefined;
  } catch {
    // ignore
  }
};

/**
 * Extract auth token from Discord. Checks three sources in order:
 * 1. Persisted cache on globalThis (survives adapter re-injection)
 * 2. localStorage via direct access or iframe fallback
 *
 * The adapter is injected at `status: 'loading'` (before Discord's JavaScript
 * runs), so localStorage still has the token on first injection. Once read,
 * the token is persisted on globalThis so it survives both Discord's
 * localStorage deletion and extension-triggered adapter re-injection.
 */
const getAuth = (): DiscordAuth | null => {
  const persisted = getPersistedToken();
  if (persisted) return { token: persisted };

  const raw = readLocalStorage('token');
  if (!raw) return null;

  try {
    const token = JSON.parse(raw) as unknown;
    if (typeof token !== 'string' || token.length === 0) return null;
    setPersistedToken(token);
    return { token };
  } catch {
    return null;
  }
};

/** Clear the cached auth token — called on 401 responses to handle token rotation. */
const clearAuthCache = (): void => {
  clearPersistedToken();
};

export const isDiscordAuthenticated = (): boolean => getAuth() !== null;

/**
 * Wait for Discord to populate the auth token after SPA hydration.
 * Polls at 500ms intervals for up to 5 seconds.
 */
export const waitForDiscordAuth = (): Promise<boolean> =>
  new Promise(resolve => {
    let elapsed = 0;
    const interval = 500;
    const maxWait = 5000;
    const timer = setInterval(() => {
      elapsed += interval;
      if (isDiscordAuthenticated()) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (elapsed >= maxWait) {
        clearInterval(timer);
        resolve(false);
      }
    }, interval);
  });

// Discord API error codes that map to specific error categories
const AUTH_ERRORS = new Set([
  0, // General auth failure
  40001, // Unauthorized
  40002, // Verification required
  50014, // Invalid authentication token
]);

const NOT_FOUND_ERRORS = new Set([
  10003, // Unknown Channel
  10004, // Unknown Guild
  10006, // Unknown Invite
  10008, // Unknown Message
  10013, // Unknown User
  10011, // Unknown Role
  10014, // Unknown Emoji
  10015, // Unknown Webhook
]);

const VALIDATION_ERRORS = new Set([
  50001, // Missing Access
  50003, // Cannot execute on DM channel
  50006, // Cannot send empty message
  50007, // Cannot send messages to this user
  50008, // Cannot edit message by another user
  50013, // Missing Permissions
  50035, // Invalid Form Body
  50109, // Request body contains invalid JSON
]);

/**
 * Make an authenticated request to the Discord API (v9).
 * Automatically extracts the token from localStorage and handles error classification.
 */
export const discordApi = async <T extends Record<string, unknown>>(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown> | FormData;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const auth = getAuth();
  if (!auth) {
    throw ToolError.auth('Not authenticated — no Discord token found. Please log in to Discord.');
  }

  const { method = 'GET', body, query } = options;

  let url = `https://discord.com/api/v9${endpoint}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: auth.token,
  };

  let fetchBody: string | FormData | undefined;
  if (body instanceof FormData) {
    fetchBody = body;
    // Do not set Content-Type for FormData — browser sets multipart boundary
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: fetchBody,
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw ToolError.timeout(`Discord API request timed out: ${method} ${endpoint}`);
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ToolError('Request was aborted', 'aborted');
    }
    throw new ToolError(
      `Network error calling Discord API: ${err instanceof Error ? err.message : String(err)}`,
      'network_error',
      { category: 'internal', retryable: true },
    );
  }

  // Handle HTTP-level errors
  if (!response.ok) {
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    const errorText = await response.text().catch(() => '');
    const errorBody = errorText.substring(0, 512);

    if (response.status === 429) {
      let retryAfterMs = retryMs;
      try {
        const parsed = JSON.parse(errorText) as { retry_after?: number };
        if (typeof parsed.retry_after === 'number') {
          retryAfterMs = parsed.retry_after * 1000;
        }
      } catch {
        // Use header value
      }
      throw ToolError.rateLimited(`Discord API rate limited: ${method} ${endpoint} — ${errorBody}`, retryAfterMs);
    }
    // Parse error body for Discord-specific error codes before classifying by HTTP status.
    // Discord uses 403 for both "unauthorized" and "missing permissions" — the error code
    // in the response body distinguishes them.
    let discordCode: number | undefined;
    let discordMessage: string | undefined;
    try {
      const parsed = JSON.parse(errorText) as { code?: number; message?: string };
      discordCode = parsed.code;
      discordMessage = parsed.message;
    } catch {
      // Not JSON — classify by HTTP status only
    }

    if (discordCode !== undefined) {
      if (VALIDATION_ERRORS.has(discordCode)) {
        throw ToolError.validation(`Discord API error: ${discordMessage ?? errorBody} (code ${String(discordCode)})`);
      }
      if (NOT_FOUND_ERRORS.has(discordCode)) {
        throw ToolError.notFound(`Discord API error: ${discordMessage ?? errorBody} (code ${String(discordCode)})`);
      }
      if (AUTH_ERRORS.has(discordCode)) {
        clearAuthCache();
        throw ToolError.auth(`Discord API error: ${discordMessage ?? errorBody} (code ${String(discordCode)})`);
      }
    }

    if (response.status === 401 || response.status === 403) {
      clearAuthCache();
      throw ToolError.auth(`Discord API auth error (${String(response.status)}): ${errorBody}`);
    }
    if (response.status === 404) {
      throw ToolError.notFound(`Discord API not found: ${method} ${endpoint} — ${errorBody}`);
    }
    throw ToolError.internal(`Discord API error (${String(response.status)}): ${method} ${endpoint} — ${errorBody}`);
  }

  // 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw ToolError.internal(`Discord API returned invalid JSON: ${method} ${endpoint}`);
  }

  // Discord API-level errors (some endpoints return 200 with error codes in body)
  if (typeof data === 'object' && data !== null && 'code' in data && 'message' in data) {
    const record = data as { code: number; message: string };
    if (AUTH_ERRORS.has(record.code)) {
      throw ToolError.auth(`Discord API error: ${record.message} (code ${String(record.code)})`);
    }
    if (NOT_FOUND_ERRORS.has(record.code)) {
      throw ToolError.notFound(`Discord API error: ${record.message} (code ${String(record.code)})`);
    }
    if (VALIDATION_ERRORS.has(record.code)) {
      throw ToolError.validation(`Discord API error: ${record.message} (code ${String(record.code)})`);
    }
  }

  return data as T;
};
