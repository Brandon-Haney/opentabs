// ---------------------------------------------------------------------------
// Fetch utilities for plugin authors
// ---------------------------------------------------------------------------

import { ToolError } from './errors.js';

export interface FetchFromPageOptions extends RequestInit {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/** Maps an HTTP error response to a ToolError with the appropriate category. */
export const httpStatusToToolError = (response: Response, message: string): ToolError => {
  const status = response.status;
  if (status === 401 || status === 403) {
    return ToolError.auth(message);
  }
  if (status === 404) {
    return ToolError.notFound(message);
  }
  if (status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const retryAfterMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
    return ToolError.rateLimited(message, retryAfterMs);
  }
  return new ToolError(message, 'http_error', { category: 'internal' });
};

/** Parses a Retry-After header value (seconds or HTTP-date) into milliseconds. */
export const parseRetryAfterMs = (value: string): number | undefined => {
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
};

/**
 * Fetches a URL using the page's authenticated session (credentials: 'include').
 * Provides built-in timeout via AbortSignal and throws a descriptive ToolError
 * on non-ok HTTP status codes.
 */
export const fetchFromPage = async (url: string, init?: FetchFromPageOptions): Promise<Response> => {
  const { timeout = 30_000, signal, ...rest } = init ?? {};

  const timeoutSignal = AbortSignal.timeout(timeout);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      ...rest,
      signal: combinedSignal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw ToolError.timeout(`fetchFromPage: request timed out after ${timeout}ms for ${url}`);
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ToolError(`fetchFromPage: request aborted for ${url}`, 'aborted');
    }
    throw new ToolError(
      `fetchFromPage: network error for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      'network_error',
      { category: 'internal', retryable: true },
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    const msg = `fetchFromPage: HTTP ${response.status} for ${url}: ${errorText}`;
    throw httpStatusToToolError(response, msg);
  }

  return response;
};

/**
 * Fetches a URL and parses the response as JSON. Uses the page's session
 * cookies (credentials: 'include') and provides timeout + error handling.
 */
export const fetchJSON = async <T>(url: string, init?: FetchFromPageOptions): Promise<T> => {
  const response = await fetchFromPage(url, init);

  try {
    return (await response.json()) as T;
  } catch {
    throw ToolError.validation(`fetchJSON: failed to parse JSON response from ${url}`);
  }
};

/**
 * Convenience wrapper for POST requests with a JSON body. Sets Content-Type,
 * stringifies the body, and parses the JSON response.
 */
export const postJSON = async <T>(url: string, body: unknown, init?: FetchFromPageOptions): Promise<T> => {
  const extraHeaders = init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
  return fetchJSON<T>(url, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
};
