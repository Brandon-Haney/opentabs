import { type FetchRetryEvent, fetchWithRetry, ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createAttemptTracker,
  FRONT_DOOR_REQUEST_STAGE_SUFFIX,
  isFrontDoorRefusal,
  readFrontDoorError,
  readUpstreamRequestId,
  recodeFetchFailure,
  upstreamUnavailableError,
} from './microsoft-upstream.js';

const HOST = 'graph.microsoft.com';
const REQUEST_STAGE_LABEL = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';
const RESPONSE_STAGE_LABEL = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpResponse';

const respond = (status: number, headers?: Record<string, string>, body: BodyInit | null = null): Response =>
  new Response(body, { status, headers });

const jsonResponse = (status: number, payload: unknown, headers?: Record<string, string>): Response =>
  respond(status, { 'content-type': 'application/json; odata.metadata=minimal', ...headers }, JSON.stringify(payload));

describe('readFrontDoorError', () => {
  test('returns null when x-proxyerrorlabel is absent or empty', () => {
    expect(readFrontDoorError(respond(500))).toBeNull();
    expect(readFrontDoorError(respond(500, { 'x-proxyerrormessage': 'The network is busy.' }))).toBeNull();
    expect(readFrontDoorError(respond(500, { 'x-proxyerrorlabel': '' }))).toBeNull();
  });

  test('reads the label alone with null message and hresult', () => {
    expect(readFrontDoorError(respond(500, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }))).toEqual({
      label: REQUEST_STAGE_LABEL,
      message: null,
      hresult: null,
    });
  });

  test('reads label, message and hresult together', () => {
    const response = respond(500, {
      'x-proxyerrorlabel': REQUEST_STAGE_LABEL,
      'x-proxyerrormessage': 'The network is busy.',
      'x-proxyerrorhresult': '0x80070036',
    });
    expect(readFrontDoorError(response)).toEqual({
      label: REQUEST_STAGE_LABEL,
      message: 'The network is busy.',
      hresult: '0x80070036',
    });
  });
});

describe('isFrontDoorRefusal', () => {
  test('is true only for a label ending in the request stage suffix', () => {
    expect(FRONT_DOOR_REQUEST_STAGE_SUFFIX).toBe('::OnHttpRequest');
    expect(isFrontDoorRefusal(respond(500, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }))).toBe(true);
    expect(isFrontDoorRefusal(respond(502, { 'x-proxyerrorlabel': 'Other::Component::OnHttpRequest' }))).toBe(true);
  });

  test('is false for a later-stage label, an unrelated label, or no label', () => {
    expect(isFrontDoorRefusal(respond(500, { 'x-proxyerrorlabel': RESPONSE_STAGE_LABEL }))).toBe(false);
    expect(isFrontDoorRefusal(respond(500, { 'x-proxyerrorlabel': 'OnHttpRequest::Later' }))).toBe(false);
    expect(isFrontDoorRefusal(respond(500))).toBe(false);
  });
});

describe('readUpstreamRequestId', () => {
  test('prefers request-id, then x-ms-request-id, then client-request-id', () => {
    expect(
      readUpstreamRequestId(new Headers({ 'request-id': 'a', 'x-ms-request-id': 'b', 'client-request-id': 'c' })),
    ).toBe('a');
    expect(readUpstreamRequestId(new Headers({ 'x-ms-request-id': 'b', 'client-request-id': 'c' }))).toBe('b');
    expect(readUpstreamRequestId(new Headers({ 'client-request-id': 'c' }))).toBe('c');
  });

  test('skips empty values and returns null when none is present', () => {
    expect(readUpstreamRequestId(new Headers({ 'request-id': '', 'x-ms-request-id': 'b' }))).toBe('b');
    expect(readUpstreamRequestId(new Headers({ 'request-id': '' }))).toBeNull();
    expect(readUpstreamRequestId(new Headers())).toBeNull();
  });
});

describe('upstreamUnavailableError', () => {
  test('classifies a bodyless 500 as retryable UPSTREAM_UNAVAILABLE with the default retry hint', async () => {
    const error = await upstreamUnavailableError(respond(500), { host: HOST, attempts: 3 });
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      category: 'internal',
      retryable: true,
      retryAfterMs: 5000,
      message: 'graph.microsoft.com returned HTTP 500 after 3 attempts.',
    });
    expect(error.details).toEqual({ httpStatus: 500, attempts: 3 });
  });

  test('uses the singular for one attempt and appends the request id when exposed', async () => {
    const error = await upstreamUnavailableError(respond(503, { 'request-id': 'abc-123' }), {
      host: HOST,
      attempts: 1,
    });
    expect(error.message).toBe('graph.microsoft.com returned HTTP 503 after 1 attempt; request-id abc-123.');
    expect(error.details).toEqual({ httpStatus: 503, attempts: 1, requestId: 'abc-123' });
  });

  test('records the request id from any of the three headers in details and omits the key when none is exposed', async () => {
    const xMs = await upstreamUnavailableError(respond(502, { 'x-ms-request-id': 'x-1' }), { host: HOST, attempts: 2 });
    expect(xMs.details).toEqual({ httpStatus: 502, attempts: 2, requestId: 'x-1' });
    const none = await upstreamUnavailableError(respond(502), { host: HOST, attempts: 2 });
    expect(none.details).toEqual({ httpStatus: 502, attempts: 2 });
    expect(none.details).not.toHaveProperty('requestId');
    expect(none.details).not.toHaveProperty('frontDoorLabel');
  });

  test('honors a Retry-After header for retryAfterMs', async () => {
    const error = await upstreamUnavailableError(respond(503, { 'Retry-After': '7' }), { host: HOST, attempts: 3 });
    expect(error.retryAfterMs).toBe(7000);
  });

  test('names the front door and quotes its message when the label is present', async () => {
    const response = respond(500, {
      'x-proxyerrorlabel': REQUEST_STAGE_LABEL,
      'x-proxyerrormessage': 'The network is busy.',
      'request-id': 'fd-1',
    });
    const error = await upstreamUnavailableError(response, { host: HOST, attempts: 3 });
    expect(error.message).toBe(
      'Microsoft\'s service front door failed the request to graph.microsoft.com with HTTP 500 "The network is busy." after 3 attempts; request-id fd-1.',
    );
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    expect(error.details).toEqual({
      httpStatus: 500,
      attempts: 3,
      requestId: 'fd-1',
      frontDoorLabel: REQUEST_STAGE_LABEL,
    });
  });

  test('names the front door without a quoted message when only the label is present', async () => {
    const error = await upstreamUnavailableError(respond(500, { 'x-proxyerrorlabel': RESPONSE_STAGE_LABEL }), {
      host: HOST,
      attempts: 2,
    });
    expect(error.message).toBe(
      "Microsoft's service front door failed the request to graph.microsoft.com with HTTP 500 after 2 attempts.",
    );
    expect(error.details).toEqual({ httpStatus: 500, attempts: 2, frontDoorLabel: RESPONSE_STAGE_LABEL });
  });

  test('includes the JSON error envelope code and message from the last response', async () => {
    const response = jsonResponse(500, {
      error: { code: 'ErrorInternalServerTransientError', message: 'An internal server error occurred.' },
    });
    const error = await upstreamUnavailableError(response, { host: HOST, attempts: 3 });
    expect(error.message).toBe(
      'graph.microsoft.com returned HTTP 500 (ErrorInternalServerTransientError: An internal server error occurred.) after 3 attempts.',
    );
  });

  test('includes an envelope that carries only a code or only a message', async () => {
    const codeOnly = await upstreamUnavailableError(jsonResponse(502, { error: { code: 'ServiceUnavailable' } }), {
      host: HOST,
      attempts: 3,
    });
    expect(codeOnly.message).toBe('graph.microsoft.com returned HTTP 502 (ServiceUnavailable) after 3 attempts.');

    const messageOnly = await upstreamUnavailableError(jsonResponse(502, { error: { message: 'Mailbox busy' } }), {
      host: HOST,
      attempts: 3,
    });
    expect(messageOnly.message).toBe('graph.microsoft.com returned HTTP 502 (Mailbox busy) after 3 attempts.');
  });

  test('truncates an oversized envelope message to 200 characters', async () => {
    const longMessage = 'x'.repeat(500);
    const error = await upstreamUnavailableError(jsonResponse(500, { error: { code: 'Long', message: longMessage } }), {
      host: HOST,
      attempts: 3,
    });
    const quoted = error.message.slice(error.message.indexOf('(') + 1, error.message.indexOf(')'));
    expect(quoted).toBe(`Long: ${'x'.repeat(199)}…`);
    expect(quoted.length).toBe('Long: '.length + 200);
  });

  test('ignores a JSON body that is malformed, non-object, or lacks the error envelope', async () => {
    const malformed = respond(500, { 'content-type': 'application/json' }, '{not json');
    expect((await upstreamUnavailableError(malformed, { host: HOST, attempts: 3 })).message).toBe(
      'graph.microsoft.com returned HTTP 500 after 3 attempts.',
    );
    expect((await upstreamUnavailableError(jsonResponse(500, 'oops'), { host: HOST, attempts: 3 })).message).toBe(
      'graph.microsoft.com returned HTTP 500 after 3 attempts.',
    );
    expect(
      (await upstreamUnavailableError(jsonResponse(500, { error: {} }), { host: HOST, attempts: 3 })).message,
    ).toBe('graph.microsoft.com returned HTTP 500 after 3 attempts.');
    expect(
      (await upstreamUnavailableError(jsonResponse(500, { message: 'top-level' }), { host: HOST, attempts: 3 }))
        .message,
    ).toBe('graph.microsoft.com returned HTTP 500 after 3 attempts.');
  });

  test('does not read a body whose content type is not JSON, nor an already consumed body', async () => {
    const html = respond(503, { 'content-type': 'text/html' }, '<html>Service Unavailable</html>');
    await upstreamUnavailableError(html, { host: HOST, attempts: 3 });
    expect(html.bodyUsed).toBe(false);

    const consumed = jsonResponse(500, { error: { code: 'Consumed' } });
    await consumed.text();
    const error = await upstreamUnavailableError(consumed, { host: HOST, attempts: 3 });
    expect(error.message).toBe('graph.microsoft.com returned HTTP 500 after 3 attempts.');
  });
});

describe('createAttemptTracker', () => {
  test('counts the initial request before any retry is observed', () => {
    expect(createAttemptTracker().attempts()).toBe(1);
  });

  test('adds one attempt per onRetry event', () => {
    const tracker = createAttemptTracker();
    tracker.onRetry({ attempt: 1, reason: 'http 500', delayMs: 400 });
    expect(tracker.attempts()).toBe(2);
    tracker.onRetry({ attempt: 2, reason: 'network', delayMs: 800 });
    expect(tracker.attempts()).toBe(3);
  });

  test('is independent per tracker', () => {
    const first = createAttemptTracker();
    const second = createAttemptTracker();
    first.onRetry({ attempt: 1, reason: 'http 503', delayMs: 1000 });
    expect(first.attempts()).toBe(2);
    expect(second.attempts()).toBe(1);
  });
});

describe('recodeFetchFailure', () => {
  test('recodes an exhausted fetchWithRetry network error into NETWORK_ERROR with the observed attempt count', () => {
    const source = new ToolError(
      'fetchWithRetry: network error reaching graph.microsoft.com after 3 attempts: Failed to fetch',
      'network_error',
      { category: 'internal', retryable: true },
    );
    const recoded = recodeFetchFailure(source, HOST, 3);
    expect(recoded).toBeInstanceOf(ToolError);
    expect(recoded).toMatchObject({
      code: 'NETWORK_ERROR',
      category: 'internal',
      retryable: true,
      message: 'Network error reaching graph.microsoft.com after 3 attempts: Failed to fetch',
      details: { attempts: 3 },
    });
  });

  test('uses the passed count, not the text, and keeps the singular wording and a multi-line cause', () => {
    const source = new ToolError(
      'fetchWithRetry: network error reaching outlook.office.com after 3 attempts: line one\nline two',
      'network_error',
    );
    expect(recodeFetchFailure(source, 'outlook.office.com', 1)).toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'Network error reaching outlook.office.com after 1 attempt: line one\nline two',
      details: { attempts: 1 },
    });
  });

  test('quotes the whole message as the cause when a network_error has an unexpected shape', () => {
    const source = new ToolError('socket hang up', 'network_error');
    expect(recodeFetchFailure(source, HOST, 2)).toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
      message: 'Network error reaching graph.microsoft.com after 2 attempts: socket hang up',
    });
  });

  test('recodes a fetchWithRetry abort into ABORTED', () => {
    const source = new ToolError('fetchWithRetry: request aborted for graph.microsoft.com', 'aborted');
    const recoded = recodeFetchFailure(source, HOST, 1);
    expect(recoded).toMatchObject({
      name: 'ToolError',
      code: 'ABORTED',
      message: 'Request to graph.microsoft.com aborted.',
    });
    expect((recoded as ToolError).details).toBeUndefined();
  });

  test('returns every other value unchanged', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(recodeFetchFailure(timeout, HOST, 1)).toBe(timeout);
    const classified = ToolError.auth('Token rejected');
    expect(recodeFetchFailure(classified, HOST, 1)).toBe(classified);
    const plain = new RangeError('bad header');
    expect(recodeFetchFailure(plain, HOST, 1)).toBe(plain);
    expect(recodeFetchFailure('string failure', HOST, 1)).toBe('string failure');
  });
});

describe('isFrontDoorRefusal as the fetchWithRetry isTransient predicate', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let onRetry: ReturnType<typeof vi.fn<(event: FetchRetryEvent) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    onRetry = vi.fn<(event: FetchRetryEvent) => void>();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('replays a POST refused at the request stage', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }))
      .mockResolvedValueOnce(respond(202));
    const promise = fetchWithRetry(
      `https://${HOST}/v1.0/me/sendMail`,
      { method: 'POST' },
      { isTransient: isFrontDoorRefusal, onRetry, jitter: false },
    );
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, reason: 'http 500', delayMs: expect.any(Number) });
  });

  test('reports the observed attempt count through createAttemptTracker', async () => {
    fetchMock.mockImplementation(async () => respond(500, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }));
    const tracker = createAttemptTracker();
    const promise = fetchWithRetry(
      `https://${HOST}/v1.0/me/sendMail`,
      { method: 'POST' },
      { isTransient: isFrontDoorRefusal, onRetry: tracker.onRetry, jitter: false },
    );
    await vi.runAllTimersAsync();
    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tracker.attempts()).toBe(3);
    const error = await upstreamUnavailableError(response, { host: HOST, attempts: tracker.attempts() });
    expect(error.message).toContain('after 3 attempts');
  });

  test('does not replay a POST that failed at a later stage', async () => {
    fetchMock.mockResolvedValue(respond(500, { 'x-proxyerrorlabel': RESPONSE_STAGE_LABEL }));
    const promise = fetchWithRetry(
      `https://${HOST}/v1.0/me/sendMail`,
      { method: 'POST' },
      { isTransient: isFrontDoorRefusal, onRetry },
    );
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
