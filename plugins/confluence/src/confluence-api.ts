import {
  getAuthCache,
  getMetaContent,
  parseRetryAfterMs,
  setAuthCache,
  ToolError,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Auth context ---

interface ConfluenceAuth {
  accountId: string;
  baseUrl: string;
  cloudId: string;
}

const getAuth = (): ConfluenceAuth | null => {
  const persisted = getAuthCache<ConfluenceAuth>('confluence');
  if (persisted) return persisted;

  const accountId = getMetaContent('ajs-atlassian-account-id') ?? getMetaContent('ajs-remote-user');
  const baseUrl = getMetaContent('ajs-base-url');
  const cloudId = getMetaContent('ajs-cloud-id');

  if (!accountId || !baseUrl) return null;

  const auth: ConfluenceAuth = {
    accountId,
    baseUrl,
    cloudId: cloudId ?? '',
  };
  setAuthCache('confluence', auth);
  return auth;
};

export const isAuthenticated = (): boolean => getAuth() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

export const getAccountId = (): string => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Confluence.');
  return auth.accountId;
};

// --- API callers ---

export const apiV2 = async <T>(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Confluence.');

  let url = `${auth.baseUrl}/api/v2${endpoint}`;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  let fetchBody: string | undefined;
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: fetchBody,
      credentials: 'include',
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
    if (response.status === 401 || response.status === 403)
      throw ToolError.auth(`Auth error (${response.status}): ${errorBody}`);
    if (response.status === 404) throw ToolError.notFound(`Not found: ${endpoint} — ${errorBody}`);
    if (response.status === 400 || response.status === 422)
      throw ToolError.validation(`Validation error (${response.status}): ${endpoint} — ${errorBody}`);
    throw ToolError.internal(`API error (${response.status}): ${endpoint} — ${errorBody}`);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};

export const apiV1 = async <T>(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Confluence.');

  let url = `${auth.baseUrl}/rest/api${endpoint}`;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  let fetchBody: string | undefined;
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: fetchBody,
      credentials: 'include',
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
    if (response.status === 401 || response.status === 403)
      throw ToolError.auth(`Auth error (${response.status}): ${errorBody}`);
    if (response.status === 404) throw ToolError.notFound(`Not found: ${endpoint} — ${errorBody}`);
    if (response.status === 400 || response.status === 422)
      throw ToolError.validation(`Validation error (${response.status}): ${endpoint} — ${errorBody}`);
    throw ToolError.internal(`API error (${response.status}): ${endpoint} — ${errorBody}`);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};

// --- File download ---

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Base64-encodes bytes in slices, so a multi-megabyte file never spreads into one oversized call. */
const encodeBase64 = (bytes: Uint8Array): string => {
  const SLICE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + SLICE));
  }
  return btoa(binary);
};

/** A downloaded file: its length in bytes and its content, base64-encoded. */
export interface DownloadedFile {
  size: number;
  contentBase64: string;
}

/**
 * Downloads a file from a download link the API reports (e.g. an attachment's
 * `downloadLink`), which is relative to the site base URL (`…/wiki`).
 *
 * Confluence Cloud answers the link with a redirect to the Atlassian media
 * service on another origin, which authenticates through a token in the
 * redirect URL and allows any origin (`Access-Control-Allow-Origin: *`). A
 * wildcard origin rejects credentialed reads, so the request uses
 * `credentials: 'same-origin'`: the session cookies reach Confluence, and the
 * cross-origin hop runs uncredentialed.
 */
export const downloadFile = async (downloadLink: string): Promise<DownloadedFile> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Confluence.');

  const url = /^https?:\/\//i.test(downloadLink) ? downloadLink : `${auth.baseUrl}${downloadLink}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: '*/*' },
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') throw ToolError.timeout('File download timed out');
    if (err instanceof DOMException && err.name === 'AbortError') throw new ToolError('Request was aborted', 'aborted');
    throw new ToolError(
      `Download network error: ${err instanceof Error ? err.message : String(err)}`,
      'network_error',
      { category: 'internal', retryable: true },
    );
  }

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
      throw ToolError.rateLimited(`Rate limited downloading the file (${response.status})`, retryMs);
    }
    if (response.status === 401 || response.status === 403)
      throw ToolError.auth(`Auth error downloading the file (${response.status})`);
    if (response.status === 404) throw ToolError.notFound('The file was not found');
    throw ToolError.internal(`Downloading the file failed (${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return { size: bytes.length, contentBase64: encodeBase64(bytes) };
};
