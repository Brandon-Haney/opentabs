import { ToolError } from '@opentabs-dev/plugin-sdk';

/**
 * Type-safe wrapper for E2E test server API calls.
 * Validates the response structure and throws ToolError on failure.
 *
 * @typeParam T - Expected shape of the successful response (excluding `ok` and `error`)
 * @param endpoint - API endpoint path (e.g., `/api/echo`, `/api/greet`)
 * @param body - Request body as a JSON-serializable object
 * @returns The parsed JSON response, typed as `T & { ok: true }`
 * @throws {ToolError} If the API returns `ok: false` or an invalid response
 */
const testApi = async <T extends Record<string, unknown>>(
  endpoint: string,
  body: Record<string, unknown> = {},
): Promise<T & { ok: true }> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new ToolError(`Test server HTTP ${response.status}: ${errorText}`, 'http_error');
  }

  const data: unknown = await response.json();

  if (typeof data !== 'object' || data === null) {
    throw new ToolError('Invalid API response format', 'invalid_response');
  }

  const record = data as Record<string, unknown>;
  if (record.ok !== true) {
    const error = typeof record.error === 'string' ? record.error : 'unknown_error';
    const errorCode = typeof record.error_code === 'string' ? record.error_code : error;
    throw new ToolError(error, errorCode);
  }

  return data as T & { ok: true };
};

export { testApi };
