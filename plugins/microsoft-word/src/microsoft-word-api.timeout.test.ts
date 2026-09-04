/**
 * Budget-expiry timing of graphFetch and fetchDownloadUrl. This suite runs in
 * Node rather than jsdom: the SDK's `sleep` forwards a signal's abort reason
 * only when it is an `Error`, and the plugin recognizes a timeout by
 * `instanceof DOMException`. Node's single realm satisfies both for one
 * TimeoutError; vitest's jsdom environment pairs jsdom's DOMException with
 * Node's Error, so a TimeoutError raised there is not an Error and the sleep
 * would surface a generic AbortError instead.
 */
import { ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchDownloadUrl, graphFetch } from './microsoft-word-api.js';

const DOWNLOAD_URL =
  'https://contoso-my.sharepoint.com/personal/x/_layouts/15/download.aspx?UniqueId=abc&tempauth=secret';
/** The per-call budget under test. */
const BUDGET_MS = 15_000;
/** When the first (transient) response arrives, leaving the backoff sleep to straddle the budget. */
const RESPONSE_AT_MS = 11_000;
/** A Retry-After within fetchWithRetry's wait cap that would end after the budget. */
const RETRY_AFTER_SEC = 8;

type Outcome = { state: 'pending' | 'resolved' | 'rejected'; error: unknown };

/** Records how `promise` settles without awaiting it, so a test can assert when it settles on the fake clock. */
const observe = (promise: Promise<unknown>): Outcome => {
  const outcome: Outcome = { state: 'pending', error: undefined };
  promise.then(
    () => {
      outcome.state = 'resolved';
    },
    (error: unknown) => {
      outcome.state = 'rejected';
      outcome.error = error;
    },
  );
  return outcome;
};

/** A fetch result that arrives after `ms` on the fake clock. */
const respondAfter = (ms: number, response: Response): Promise<Response> =>
  new Promise(resolve => setTimeout(() => resolve(response), ms));

/**
 * Makes `AbortSignal.timeout` fire on the fake clock. The built-in schedules
 * its expiry on the runtime's internal timers, which `vi.useFakeTimers` does
 * not advance, so the stand-in raises the same TimeoutError from the faked
 * `setTimeout`. Restored by `vi.restoreAllMocks()` after each test.
 */
const stubTimeoutSignals = (): void => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
};

type OpenTabsGlobal = { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } };
const setNamespace = (values: Record<string, unknown> | undefined): void => {
  (globalThis as OpenTabsGlobal).__openTabs =
    values === undefined ? undefined : { preScript: { 'microsoft-word': values } };
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  stubTimeoutSignals();
  setNamespace({ graph: { token: 'graph-token', exp: Math.floor(Date.now() / 1000) + 1800 } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setNamespace(undefined);
});

describe('budget expiry during a Retry-After sleep', () => {
  test.each([
    {
      name: 'graphFetch',
      status: 429,
      message: 'Microsoft Graph API request timed out.',
      request: () => graphFetch('/me', { timeoutMs: BUDGET_MS }),
    },
    {
      name: 'fetchDownloadUrl',
      status: 503,
      message: 'File download timed out.',
      request: () => fetchDownloadUrl(DOWNLOAD_URL, { timeoutMs: BUDGET_MS }),
    },
  ])('$name throws TIMEOUT the moment the budget expires', async ({ status, message, request }) => {
    fetchMock.mockImplementationOnce(() =>
      respondAfter(
        RESPONSE_AT_MS,
        new Response(`body-${status}`, { status, headers: { 'Retry-After': String(RETRY_AFTER_SEC) } }),
      ),
    );
    const outcome = observe(request());

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(outcome.state).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(ToolError);
    expect(outcome.error).toMatchObject({ code: 'TIMEOUT', message });

    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
