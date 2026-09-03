import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ToolError } from './errors.js';
import { type FetchRetryEvent, fetchWithRetry } from './fetch-retry.js';
import { _setLogTransport, type LogEntry } from './log.js';

const URL_UNDER_TEST = 'https://api.example.com/v1/items/12345';
const HOST = 'api.example.com';

const respond = (status: number, headers?: Record<string, string>): Response =>
  new Response(`body-${status}`, { status, headers });

/** Resolves `promise` while draining every pending timer so retry sleeps complete under fake timers. */
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  await vi.runAllTimersAsync();
  return promise;
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let entries: LogEntry[];
let restoreLog: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  entries = [];
  restoreLog = _setLogTransport(entry => entries.push(entry));
});

afterEach(() => {
  restoreLog();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchWithRetry — status-based retries', () => {
  test('returns the first successful response without retrying', async () => {
    fetchMock.mockResolvedValueOnce(respond(200));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(0);
  });

  test('retries an idempotent GET on 500 and returns the eventual 200', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    408, 429, 502, 503, 504,
  ])('retries GET on %i up to maxAttempts and returns the last response', async status => {
    fetchMock.mockResolvedValue(respond(status));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { maxAttempts: 3 }));
    expect(response.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test.each([
    400, 401, 403, 404, 409, 422, 501, 505,
  ])('returns a %i response untouched without retrying', async status => {
    fetchMock.mockResolvedValue(respond(status));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(`body-${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('treats HEAD and OPTIONS as idempotent', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(200));
    await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'head' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(200));
    await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'OPTIONS' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithRetry — non-idempotent methods', () => {
  test.each([
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
  ])('does not retry %s on 500 by default and returns the response', async method => {
    fetchMock.mockResolvedValue(respond(500));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, { method }));
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retries POST on 500 when retryNonIdempotent is true', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(201));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { retryNonIdempotent: true }));
    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('retries POST on 500 when isTransient vouches for the response', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': 'Http::Proxy::OnHttpRequest' }))
      .mockResolvedValueOnce(respond(201));
    const isTransient = vi.fn((response: Response) => response.headers.get('x-proxyerrorlabel') !== null);
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { isTransient }));
    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isTransient).toHaveBeenCalledTimes(1);
  });

  test('does not retry POST on 500 when isTransient declines', async () => {
    fetchMock.mockResolvedValue(respond(500));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { isTransient: () => false }));
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('isTransient is not consulted when the status already qualifies for an idempotent method', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200));
    const isTransient = vi.fn(() => true);
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { isTransient }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isTransient).not.toHaveBeenCalled();
  });

  test('isTransient is not consulted for ok responses', async () => {
    fetchMock.mockResolvedValueOnce(respond(200));
    const isTransient = vi.fn(() => true);
    await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { isTransient }));
    expect(isTransient).not.toHaveBeenCalled();
  });

  test('isTransient is not consulted on the final attempt', async () => {
    fetchMock.mockResolvedValue(respond(500, { 'x-proxyerrorlabel': 'Http::Proxy::OnHttpRequest' }));
    const isTransient = vi.fn(() => true);
    const single = await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { maxAttempts: 1, isTransient }));
    expect(single.status).toBe(500);
    expect(await single.text()).toBe('body-500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isTransient).not.toHaveBeenCalled();

    fetchMock.mockClear();
    const last = await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { maxAttempts: 3, isTransient }));
    expect(last.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(isTransient).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithRetry — Retry-After', () => {
  test('waits a short Retry-After on 429 before retrying', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '1' })).mockResolvedValueOnce(respond(200));
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, { jitter: false });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await promise).status).toBe(200);
    expect(entries[0]?.data[0]).toMatchObject({ reason: 'http 429', delayMs: 1000 });
  });

  test('honors Retry-After on 503', async () => {
    fetchMock.mockResolvedValueOnce(respond(503, { 'Retry-After': '2' })).mockResolvedValueOnce(respond(200));
    const promise = fetchWithRetry(URL_UNDER_TEST);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await promise;
  });

  test('returns a 429 immediately when Retry-After exceeds maxRetryAfterMs', async () => {
    fetchMock.mockResolvedValue(respond(429, { 'Retry-After': '30' }));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(0);
  });

  test('returns the response when Retry-After fits maxRetryAfterMs but overruns the deadline', async () => {
    fetchMock.mockResolvedValue(respond(503, { 'Retry-After': '1' }));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { deadlineMs: 500 }));
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('ignores Retry-After on statuses other than 429 and 503', async () => {
    fetchMock.mockResolvedValueOnce(respond(500, { 'Retry-After': '30' })).mockResolvedValueOnce(respond(200));
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, { jitter: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await promise;
  });
});

describe('fetchWithRetry — backoff and deadline', () => {
  test('doubles the delay per attempt and caps it at maxDelayMs', async () => {
    fetchMock.mockResolvedValue(respond(500));
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, {
      maxAttempts: 4,
      baseDelayMs: 400,
      maxDelayMs: 500,
      jitter: false,
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await promise).status).toBe(500);
    expect(entries.map(entry => (entry.data[0] as { delayMs: number }).delayMs)).toEqual([400, 500, 500]);
  });

  test('applies equal jitter in [d/2, d] by default', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, { baseDelayMs: 400 });
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await promise;
    expect(entries[0]?.data[0]).toMatchObject({ delayMs: 200 });
  });

  test('stops retrying when the next delay would pass the deadline', async () => {
    fetchMock.mockResolvedValue(respond(500));
    const response = await settle(
      fetchWithRetry(URL_UNDER_TEST, undefined, { maxAttempts: 5, baseDelayMs: 400, deadlineMs: 1000, jitter: false }),
    );
    expect(response.status).toBe(500);
    // 400ms sleep fits (400 <= 1000); the following 800ms sleep would end at 1200ms.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('rejects a non-positive or fractional maxAttempts', async () => {
    await expect(fetchWithRetry(URL_UNDER_TEST, undefined, { maxAttempts: 0 })).rejects.toThrow(
      'fetchWithRetry: maxAttempts must be an integer >= 1, got 0',
    );
    await expect(fetchWithRetry(URL_UNDER_TEST, undefined, { maxAttempts: 1.5 })).rejects.toThrow(
      'maxAttempts must be an integer >= 1',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchWithRetry — network failures', () => {
  test('retries a network TypeError for GET and throws a retryable network_error after exhausting attempts', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, { jitter: false });
    const expectation = expect(promise).rejects.toMatchObject({
      name: 'ToolError',
      code: 'network_error',
      category: 'internal',
      retryable: true,
      message: `fetchWithRetry: network error reaching ${HOST} after 3 attempts: Failed to fetch`,
    });
    await vi.runAllTimersAsync();
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.data[0]).toMatchObject({
      host: HOST,
      method: 'GET',
      attempt: 1,
      reason: 'network',
      delayMs: 400,
    });
  });

  test('does not retry a network TypeError for POST unless retryNonIdempotent', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' })).rejects.toMatchObject({
      code: 'network_error',
      message: `fetchWithRetry: network error reaching ${HOST} after 1 attempt: Failed to fetch`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(respond(201));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { retryNonIdempotent: true }));
    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('throws the network error without sleeping when the deadline is exhausted', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchWithRetry(URL_UNDER_TEST, undefined, { deadlineMs: 100, jitter: false })).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rethrows a TimeoutError DOMException untouched without retrying', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    fetchMock.mockRejectedValue(timeout);
    await expect(fetchWithRetry(URL_UNDER_TEST)).rejects.toBe(timeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rethrows non-TypeError failures untouched', async () => {
    const failure = new RangeError('bad header value');
    fetchMock.mockRejectedValue(failure);
    await expect(fetchWithRetry(URL_UNDER_TEST)).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithRetry — abort', () => {
  test('throws ToolError aborted without a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchWithRetry(URL_UNDER_TEST, undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: 'ToolError',
      code: 'aborted',
      message: `fetchWithRetry: request aborted for ${HOST}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('throws ToolError aborted when the signal aborts during a retry sleep', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(respond(500));
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, { signal: controller.signal, jitter: false });
    const expectation = expect(promise).rejects.toMatchObject({ name: 'ToolError', code: 'aborted' });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort(new Error('caller cancelled'));
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('throws ToolError aborted when the signal aborts a retry sleep while init.signal is also set', async () => {
    const controller = new AbortController();
    const requestController = new AbortController();
    fetchMock.mockResolvedValue(respond(500));
    const promise = fetchWithRetry(
      URL_UNDER_TEST,
      { signal: requestController.signal },
      { signal: controller.signal, jitter: false },
    );
    const expectation = expect(promise).rejects.toMatchObject({ name: 'ToolError', code: 'aborted' });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('caller cancelled'));
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('surfaces the TimeoutError of init.signal as soon as it fires during a retry sleep', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const requestController = new AbortController();
    setTimeout(() => requestController.abort(timeout), 100);
    fetchMock.mockResolvedValue(respond(500));
    const promise = fetchWithRetry(
      URL_UNDER_TEST,
      { signal: requestController.signal },
      { baseDelayMs: 400, jitter: false },
    );
    let outcome: 'pending' | 'rejected' = 'pending';
    const expectation = expect(promise).rejects.toBe(timeout);
    promise.catch(() => {
      outcome = 'rejected';
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('rejected');
    await expectation;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('throws ToolError aborted when the signal aborts an in-flight request', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, { signal: controller.signal });
    const expectation = expect(promise).rejects.toBeInstanceOf(ToolError);
    controller.abort();
    await expectation;
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });

  test('combines the caller signal with init.signal and forwards init.signal alone otherwise', async () => {
    fetchMock.mockResolvedValue(respond(200));
    const requestSignal = AbortSignal.timeout(30_000);
    await settle(fetchWithRetry(URL_UNDER_TEST, { signal: requestSignal }));
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(requestSignal);

    const controller = new AbortController();
    await settle(fetchWithRetry(URL_UNDER_TEST, { signal: requestSignal }, { signal: controller.signal }));
    const combined = fetchMock.mock.calls[1]?.[1]?.signal;
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined).not.toBe(requestSignal);
    expect(combined?.aborted).toBe(false);
    controller.abort();
    expect(combined?.aborted).toBe(true);
  });
});

describe('fetchWithRetry — request forwarding and body handling', () => {
  test('forwards method, headers and body on every attempt', async () => {
    fetchMock.mockResolvedValueOnce(respond(502)).mockResolvedValueOnce(respond(200));
    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: '{"a":1}',
      credentials: 'omit',
    };
    await settle(fetchWithRetry(URL_UNDER_TEST, init, { retryNonIdempotent: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(URL_UNDER_TEST);
      expect(call[1]).toMatchObject({
        method: 'POST',
        headers: init.headers,
        body: '{"a":1}',
        credentials: 'omit',
      });
    }
  });

  test('cancels the body of every retried response and leaves the returned response untouched', async () => {
    const first = respond(500);
    const second = respond(503);
    const last = respond(504);
    const cancels = [first, second, last].map(response => {
      const body = response.body;
      if (body === null) throw new Error('test responses must carry a body');
      return vi.spyOn(body, 'cancel');
    });
    fetchMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(last);

    const response = await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { maxAttempts: 3 }));
    expect(response).toBe(last);
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(cancels[1]).toHaveBeenCalledTimes(1);
    expect(cancels[2]).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('body-504');
  });
});

describe('fetchWithRetry — onRetry', () => {
  test('reports each retry with the failed attempt number, the reason and the upcoming delay', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(respond(200));
    const onRetry = vi.fn<(event: FetchRetryEvent) => void>();
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { jitter: false, onRetry }));
    expect(response.status).toBe(200);
    expect(onRetry.mock.calls).toEqual([
      [{ attempt: 1, reason: 'http 500', delayMs: 400 }],
      [{ attempt: 2, reason: 'network', delayMs: 800 }],
    ]);
  });

  test('passes the same reason and delay that the warn log carries', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '2' })).mockResolvedValueOnce(respond(200));
    const onRetry = vi.fn<(event: FetchRetryEvent) => void>();
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { onRetry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const event = onRetry.mock.calls[0]?.[0];
    expect(entries[0]?.data[0]).toMatchObject({ reason: event?.reason, delayMs: event?.delayMs });
    expect(event).toEqual({ attempt: 1, reason: 'http 429', delayMs: 2000 });
  });

  test('is invoked synchronously before the backoff sleep starts', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(200));
    const onRetry = vi.fn<(event: FetchRetryEvent) => void>(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { onRetry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('is not invoked for the final attempt or for a response returned without retry', async () => {
    fetchMock.mockResolvedValue(respond(500));
    const onRetry = vi.fn<(event: FetchRetryEvent) => void>();
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { maxAttempts: 3, onRetry }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(([event]) => event.attempt)).toEqual([1, 2]);

    onRetry.mockClear();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(respond(404));
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { onRetry }));
    expect(onRetry).not.toHaveBeenCalled();

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(respond(429, { 'Retry-After': '30' }));
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { onRetry }));
    expect(onRetry).not.toHaveBeenCalled();
  });

  test('is not invoked when a network failure exhausts its attempts without a retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const onRetry = vi.fn<(event: FetchRetryEvent) => void>();
    await expect(fetchWithRetry(URL_UNDER_TEST, { method: 'POST' }, { onRetry })).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(onRetry).not.toHaveBeenCalled();
  });

  test('propagates an exception thrown by the callback and stops retrying', async () => {
    fetchMock.mockResolvedValue(respond(500));
    const failure = new Error('observer failed');
    const promise = fetchWithRetry(URL_UNDER_TEST, undefined, {
      onRetry: () => {
        throw failure;
      },
    });
    await expect(promise).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fetchWithRetry — ReadableStream request bodies', () => {
  const streamInit = (method: string): RequestInit => ({
    method,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
        controller.close();
      },
    }),
  });

  test('does not retry a POST 500 even with retryNonIdempotent and returns the response untouched', async () => {
    fetchMock.mockResolvedValue(respond(500));
    const onRetry = vi.fn<(event: FetchRetryEvent) => void>();
    const response = await settle(
      fetchWithRetry(URL_UNDER_TEST, streamInit('POST'), { retryNonIdempotent: true, onRetry }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('body-500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(0);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test('does not retry an idempotent method carrying a stream body', async () => {
    fetchMock.mockResolvedValue(respond(503));
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, streamInit('GET')));
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not consult isTransient and never retries on its vouching', async () => {
    fetchMock.mockResolvedValue(respond(500, { 'x-proxyerrorlabel': 'Http::Proxy::OnHttpRequest' }));
    const isTransient = vi.fn(() => true);
    const response = await settle(fetchWithRetry(URL_UNDER_TEST, streamInit('POST'), { isTransient }));
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isTransient).not.toHaveBeenCalled();
  });

  test('throws the network error after a single attempt even with retryNonIdempotent', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchWithRetry(URL_UNDER_TEST, streamInit('PUT'), { retryNonIdempotent: true })).rejects.toMatchObject(
      {
        code: 'network_error',
        message: `fetchWithRetry: network error reaching ${HOST} after 1 attempt: Failed to fetch`,
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(0);
  });
});

describe('fetchWithRetry — logging', () => {
  test('emits one warn per retry with host-only context when no location global exists', async () => {
    expect(typeof location).toBe('undefined');
    fetchMock
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(502))
      .mockResolvedValueOnce(respond(200));
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { jitter: false }));

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.level).toBe('warning');
      expect(entry.message).toBe('transient upstream failure, retrying');
      expect(JSON.stringify(entry.data)).not.toContain('/v1/items/12345');
    }
    expect(entries[0]?.data[0]).toEqual({ host: HOST, method: 'GET', attempt: 1, reason: 'http 500', delayMs: 400 });
    expect(entries[1]?.data[0]).toEqual({ host: HOST, method: 'GET', attempt: 2, reason: 'http 502', delayMs: 800 });
  });

  test('includes the label when provided', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200));
    await settle(fetchWithRetry(URL_UNDER_TEST, undefined, { jitter: false, label: 'graph-mail' }));
    expect(entries[0]?.data[0]).toMatchObject({ host: HOST, label: 'graph-mail' });
  });

  test('falls back to <invalid-url> for an unparseable URL', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchWithRetry('not a url', { method: 'POST' })).rejects.toMatchObject({
      message: 'fetchWithRetry: network error reaching <invalid-url> after 1 attempt: Failed to fetch',
    });
  });
});
