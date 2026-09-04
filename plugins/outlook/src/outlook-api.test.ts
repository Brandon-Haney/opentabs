/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://outlook.cloud.microsoft/mail/"}
 */
import { log, setAuthCache, ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GRAPH_API_BASE, OUTLOOK_API_BASE } from './auth-candidates.js';
import { resetCascadeMemory } from './auth-cascade-memory.js';
import {
  api,
  attachLargeFileToMessage,
  describeCachedAuth,
  describeRejectedAuth,
  owsRequest,
  PROBE_TIMEOUT_MS,
  probeApiBase,
  uploadAttachmentToOneDrive,
} from './outlook-api.js';
import { tokenFingerprint } from './token-fingerprint.js';

// The SDK freezes `log`, so its methods cannot be spied on; the module mock swaps the object.
vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ENTERPRISE_CLIENT_ID = '9199bf20-a13f-4107-85dc-02114787ef48';
const GRAPH_TOKEN = 'graph-token-secret';
const REST_TOKEN = 'rest-token-secret';
const FRONT_DOOR_REFUSAL = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';
const MAIL_SLOT = 'outlook';
/** Mirrors UPLOAD_SESSION_CHUNK_BYTES: every chunk but the last is 10 × 320 KiB. */
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10;

/** Seeds the MSAL v3 enterprise cache with one Graph and one Outlook REST token, both valid for an hour. */
const seedTokens = (): void => {
  const expiresOn = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem(
    `msal.3.token.keys.${ENTERPRISE_CLIENT_ID}`,
    JSON.stringify({ accessToken: ['graph-entry', 'rest-entry'] }),
  );
  localStorage.setItem(
    'graph-entry',
    JSON.stringify({ secret: GRAPH_TOKEN, target: 'https://graph.microsoft.com/Mail.Read', expiresOn }),
  );
  localStorage.setItem(
    'rest-entry',
    JSON.stringify({ secret: REST_TOKEN, target: 'https://outlook.office.com/Mail.ReadWrite', expiresOn }),
  );
};

const resetTokenCache = (): void => {
  const g = globalThis as { __openTabs?: { tokenCache?: Record<string, unknown> } };
  if (g.__openTabs) g.__openTabs.tokenCache = {};
};

const respond = (status: number, headers?: Record<string, string>, body: BodyInit | null = null): Response =>
  new Response(body, { status, headers });

const json = (status: number, payload: unknown, headers?: Record<string, string>): Response =>
  respond(status, { 'content-type': 'application/json; odata.metadata=minimal', ...headers }, JSON.stringify(payload));

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

/** The request `fetch` received on call `index`, with its bearer token and URL host pulled out. */
const request = (index: number): { url: string; host: string; init: RequestInit; token: string | null } => {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch was called ${fetchMock.mock.calls.length} times; no call ${index}`);
  const [input, init] = call;
  const url = String(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const token = headers.Authorization?.replace(/^Bearer /, '') ?? null;
  return { url, host: new URL(url).host, init: init ?? {}, token };
};

/** Awaits a promise that may sleep between retries, attaching the expectation before draining timers. */
const settled = async <T>(promise: Promise<T>): Promise<T> => {
  const guarded = promise.catch((error: unknown) => ({ __rejected: error }));
  await vi.runAllTimersAsync();
  const outcome = await guarded;
  if (typeof outcome === 'object' && outcome !== null && '__rejected' in outcome) throw outcome.__rejected;
  return outcome as T;
};

const rejection = async (promise: Promise<unknown>): Promise<ToolError> => {
  try {
    await settled(promise);
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetTokenCache();
  resetCascadeMemory();
  seedTokens();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(log.debug).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('api — auth cascade with negative cache', () => {
  test('falls back from a rejected Graph token to REST, then reuses REST without re-trying Graph', async () => {
    fetchMock
      .mockResolvedValueOnce(json(403, { error: { code: 'ErrorAccessDenied' } }))
      .mockResolvedValueOnce(json(200, { Value: [{ Subject: 'hello' }] }));

    const first = await settled(api<{ value: { subject: string }[] }>('/me/messages'));
    expect(first).toEqual({ value: [{ subject: 'hello' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(request(0)).toMatchObject({ host: 'graph.microsoft.com', token: GRAPH_TOKEN });
    expect(request(1)).toMatchObject({ host: 'outlook.office.com', token: REST_TOKEN });
    expect(describeCachedAuth()).toEqual([
      {
        slot: 'mail',
        apiBase: OUTLOOK_API_BASE,
        fingerprint: tokenFingerprint(REST_TOKEN),
        expiresAt: expect.any(String),
      },
    ]);
    expect(describeRejectedAuth()).toEqual([
      {
        slot: 'mail',
        apiBase: GRAPH_API_BASE,
        fingerprint: tokenFingerprint(GRAPH_TOKEN),
        rejectedAt: expect.any(String),
      },
    ]);
    expect(log.debug).toHaveBeenCalledWith('Microsoft token candidate rejected', {
      slot: MAIL_SLOT,
      audience: 'graph.microsoft.com',
      fingerprint: tokenFingerprint(GRAPH_TOKEN),
    });

    fetchMock.mockResolvedValueOnce(json(200, { Value: [] }));
    await settled(api('/me/messages'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(request(2)).toMatchObject({ host: 'outlook.office.com', token: REST_TOKEN });
  });

  test('skips remembered rejections on a later cascade and retries them all once every candidate is rejected', async () => {
    fetchMock.mockResolvedValueOnce(respond(403)).mockResolvedValueOnce(respond(401));
    const first = await rejection(api('/me/messages'));
    expect(first).toMatchObject({
      category: 'auth',
      message: 'Authentication expired — please refresh the Outlook page.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(describeRejectedAuth()).toHaveLength(2);

    // Every candidate is remembered as rejected, so the memory is cleared and both are tried again.
    fetchMock.mockResolvedValueOnce(respond(403)).mockResolvedValueOnce(respond(403));
    await rejection(api('/me/messages'));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(request(2).token).toBe(GRAPH_TOKEN);
    expect(request(3).token).toBe(REST_TOKEN);
    expect(describeRejectedAuth()).toHaveLength(2);
  });

  test('with no token on hand at all, reports a missing sign-in without sending anything', async () => {
    localStorage.clear();
    const error = await rejection(api('/me/messages'));
    expect(error).toMatchObject({
      category: 'auth',
      message: 'Not authenticated — please sign in to Microsoft 365.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(describeCachedAuth()).toEqual([]);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('a rejected cached winner with no other candidate reports an expired session, not a missing sign-in', async () => {
    localStorage.setItem(`msal.3.token.keys.${ENTERPRISE_CLIENT_ID}`, JSON.stringify({ accessToken: ['graph-entry'] }));
    setAuthCache(MAIL_SLOT, { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE });
    fetchMock.mockResolvedValueOnce(respond(401));

    const error = await rejection(api('/me/messages'));
    expect(error).toMatchObject({
      category: 'auth',
      message: 'Authentication expired — please refresh the Outlook page.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeCachedAuth()).toEqual([]);
    expect(describeRejectedAuth()).toEqual([
      expect.objectContaining({ slot: 'mail', apiBase: GRAPH_API_BASE, fingerprint: tokenFingerprint(GRAPH_TOKEN) }),
    ]);
  });

  test('a cached token rejected by the API is evicted, remembered, and the next candidate cached instead', async () => {
    setAuthCache(MAIL_SLOT, { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE });
    fetchMock.mockResolvedValueOnce(respond(401)).mockResolvedValueOnce(json(200, { Value: [] }));

    await settled(api('/me/messages'));
    expect(describeCachedAuth().find(entry => entry.slot === 'mail')?.apiBase).toBe(OUTLOOK_API_BASE);
    expect(describeRejectedAuth()).toEqual([expect.objectContaining({ slot: 'mail', apiBase: GRAPH_API_BASE })]);
    expect(log.debug).toHaveBeenCalledWith('Cached Microsoft token rejected; re-cascading', expect.any(Object));
  });

  test('a downstream 5xx thrown from the attempt neither evicts nor negative-caches the cached token', async () => {
    setAuthCache(MAIL_SLOT, { token: REST_TOKEN, apiBase: OUTLOOK_API_BASE });
    // A fresh Response per attempt, as fetch returns: the retried ones have their bodies cancelled.
    fetchMock.mockImplementation(async () =>
      json(500, { error: { code: 'ErrorInternalServerTransientError', message: 'Busy' } }),
    );

    const error = await rejection(api('/me/messages'));
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', category: 'internal', retryable: true });
    expect(error.message).toContain('outlook.office.com returned HTTP 500');
    expect(error.message).toContain('ErrorInternalServerTransientError: Busy');
    expect(error.message).toContain('after 3 attempts');
    expect(error.message).not.toContain('/me/messages');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(describeCachedAuth().find(entry => entry.slot === 'mail')?.apiBase).toBe(OUTLOOK_API_BASE);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('a cached winner skipped for one call is neither evicted nor overwritten by the accepted alternative', async () => {
    setAuthCache(MAIL_SLOT, { token: REST_TOKEN, apiBase: OUTLOOK_API_BASE });
    fetchMock
      .mockResolvedValueOnce(json(200, { uploadUrl: 'https://upload.example.com/session?tempauth=signed-secret' }))
      .mockResolvedValueOnce(respond(201));

    await settled(attachLargeFileToMessage('draft-1', { name: 'big.bin', bytes: new Uint8Array([1, 2, 3, 4]) }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(request(0)).toMatchObject({ host: 'graph.microsoft.com', token: GRAPH_TOKEN });
    expect(request(0).url).toContain('/me/messages/draft-1/attachments/createUploadSession');
    expect(request(1)).toMatchObject({ host: 'upload.example.com', token: null });
    expect((request(1).init.headers as Record<string, string>)['Content-Range']).toBe('bytes 0-3/4');
    expect(describeCachedAuth()).toEqual([expect.objectContaining({ slot: 'mail', apiBase: OUTLOOK_API_BASE })]);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('a Graph-only call with only an Outlook REST token on hand names the missing Graph token and touches nothing', async () => {
    localStorage.setItem(`msal.3.token.keys.${ENTERPRISE_CLIENT_ID}`, JSON.stringify({ accessToken: ['rest-entry'] }));
    setAuthCache(MAIL_SLOT, { token: REST_TOKEN, apiBase: OUTLOOK_API_BASE });
    const expectedMessage =
      'No Microsoft Graph token is available for this operation — please refresh the Outlook page.';

    const withCache = await rejection(
      attachLargeFileToMessage('draft-1', { name: 'big.bin', bytes: new Uint8Array(4) }),
    );
    expect(withCache).toMatchObject({ category: 'auth', message: expectedMessage });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(describeCachedAuth()).toEqual([
      expect.objectContaining({ slot: 'mail', apiBase: OUTLOOK_API_BASE, fingerprint: tokenFingerprint(REST_TOKEN) }),
    ]);
    expect(describeRejectedAuth()).toEqual([]);

    resetTokenCache();
    const withoutCache = await rejection(
      attachLargeFileToMessage('draft-1', { name: 'big.bin', bytes: new Uint8Array(4) }),
    );
    expect(withoutCache).toMatchObject({ category: 'auth', message: expectedMessage });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(describeCachedAuth()).toEqual([]);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('reports the bytes committed after every chunk of a multi-chunk upload', async () => {
    setAuthCache(MAIL_SLOT, { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE });
    const total = UPLOAD_CHUNK_BYTES + 4;
    fetchMock
      .mockResolvedValueOnce(json(200, { uploadUrl: 'https://upload.example.com/session?tempauth=signed-secret' }))
      .mockResolvedValueOnce(respond(200))
      .mockResolvedValueOnce(respond(201));
    const onProgress = vi.fn();

    await settled(attachLargeFileToMessage('draft-1', { name: 'big.bin', bytes: new Uint8Array(total) }, onProgress));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((request(1).init.headers as Record<string, string>)['Content-Range']).toBe(
      `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${total}`,
    );
    expect((request(2).init.headers as Record<string, string>)['Content-Range']).toBe(
      `bytes ${UPLOAD_CHUNK_BYTES}-${total - 1}/${total}`,
    );
    expect(onProgress.mock.calls).toEqual([
      [UPLOAD_CHUNK_BYTES, total],
      [total, total],
    ]);
  });

  test('a chunk PUT is never replayed on a plain 5xx', async () => {
    setAuthCache(MAIL_SLOT, { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE });
    fetchMock
      .mockResolvedValueOnce(json(200, { uploadUrl: 'https://upload.example.com/session?tempauth=signed-secret' }))
      .mockResolvedValueOnce(respond(503, { 'Retry-After': '1' }));

    const error = await rejection(attachLargeFileToMessage('draft-1', { name: 'big.bin', bytes: new Uint8Array(4) }));
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryAfterMs: 1000 });
    expect(error.message).toContain('upload.example.com returned HTTP 503');
    expect(error.message).toContain('after 1 attempt.');
    expect(error.message).not.toContain('tempauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('api — transient retry policy', () => {
  beforeEach(() => {
    setAuthCache(MAIL_SLOT, { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE });
  });

  test('retries a GET on 500 and returns the eventual 200', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(json(200, { value: [] }));
    expect(await settled(api('/me/messages'))).toEqual({ value: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not replay a POST on a plain 5xx and says so', async () => {
    fetchMock.mockResolvedValueOnce(respond(502));
    const error = await rejection(api('/me/sendMail', { method: 'POST', body: { message: {} } }));
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', category: 'internal', retryable: true });
    expect(error.message).toContain('HTTP 502');
    expect(error.message).toContain('after 1 attempt.');
    expect(error.details).toEqual({ httpStatus: 502, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('replays a POST that opts in with retryNonIdempotent', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(json(200, { value: [] }));
    const result = await settled(
      api(
        '/me/calendar/getSchedule',
        { method: 'POST', body: { schedules: [] }, retryNonIdempotent: true },
        'calendar',
      ),
    );
    expect(result).toEqual({ value: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('replays a POST the front door refused before forwarding it', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL, 'x-proxyerrormessage': 'Busy.' }))
      .mockResolvedValueOnce(respond(202));
    expect(await settled(api('/me/sendMail', { method: 'POST', body: { message: {} } }))).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('names the front door and counts every attempt when refusals exhaust the retries', async () => {
    fetchMock.mockResolvedValue(
      respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL, 'x-proxyerrormessage': 'Busy.', 'request-id': 'req-9' }),
    );
    const error = await rejection(api('/me/sendMail', { method: 'POST', body: { message: {} } }));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain("Microsoft's service front door failed the request to graph.microsoft.com");
    expect(error.message).toContain('after 3 attempts; request-id req-9');
    expect(error.details).toEqual({
      httpStatus: 500,
      attempts: 3,
      requestId: 'req-9',
      frontDoorLabel: FRONT_DOOR_REFUSAL,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('does not retry a GET whose first transient response arrives after the retry deadline', async () => {
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 21_000);
      return respond(500);
    });
    const error = await rejection(api('/me/messages'));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 1 attempt.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('surfaces a 429 as rate_limit with the parsed Retry-After and the request id in details', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '30', 'x-ms-request-id': 'throttled-1' }));
    const error = await rejection(api('/me/messages'));
    expect(error).toMatchObject({ category: 'rate_limit', retryAfterMs: 30_000 });
    expect(error.details).toEqual({ httpStatus: 429, requestId: 'throttled-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('recodes an exhausted network failure to NETWORK_ERROR naming only the host', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(api('/me/messages'));
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', category: 'internal', retryable: true });
    expect(error.message).toBe('Network error reaching graph.microsoft.com after 3 attempts: Failed to fetch');
    expect(error.details).toEqual({ attempts: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('does not replay a POST on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(api('/me/sendMail', { method: 'POST', body: { message: {} } }));
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('after 1 attempt:');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('maps a timeout to the timeout category without retrying', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    const error = await rejection(api('/me/messages'));
    expect(error).toMatchObject({ category: 'timeout', message: 'Microsoft API request timed out.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps 404 and 400 classification and records the status and request id in details', async () => {
    fetchMock.mockResolvedValueOnce(respond(404, { 'request-id': 'missing-1' }));
    const notFound = await rejection(api('/me/messages/missing'));
    expect(notFound.category).toBe('not_found');
    expect(notFound.details).toEqual({ httpStatus: 404, requestId: 'missing-1' });

    fetchMock.mockResolvedValueOnce(json(400, { error: { message: 'Invalid filter clause' } }));
    const validation = await rejection(api('/me/messages', { query: { $filter: 'bad' } }));
    expect(validation).toMatchObject({ category: 'validation', message: 'Invalid filter clause' });
    expect(validation.details).toEqual({ httpStatus: 400 });
  });

  test('sends every Graph request with credentials omitted, a bearer header and a timeout signal', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await settled(api('/me'));
    const { init, token } = request(0);
    expect(init.credentials).toBe('omit');
    expect(token).toBe(GRAPH_TOKEN);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('owsRequest', () => {
  test('replays the startupdata POST when marked retryNonIdempotent and caches the winner in the ows slot', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(json(200, { owaUserConfig: {} }));
    const data = await settled(
      owsRequest('/owa/startupdata.ashx', { method: 'POST', query: { app: 'Mail', n: 0 }, retryNonIdempotent: true }),
    );
    expect(data).toEqual({ owaUserConfig: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(request(0).url).toBe('https://outlook.cloud.microsoft/owa/startupdata.ashx?app=Mail&n=0');
    expect(request(0).init.credentials).toBe('same-origin');
    expect(describeCachedAuth()).toEqual([expect.objectContaining({ slot: 'ows', apiBase: GRAPH_API_BASE })]);
  });

  test('treats a 404 as an accepted empty result and a 401 as a rejection', async () => {
    fetchMock.mockResolvedValueOnce(respond(401)).mockResolvedValueOnce(respond(404));
    expect(await settled(owsRequest('/ows/v1/OutlookCloudSettings/settings/account'))).toBeUndefined();
    expect(request(0).token).toBe(GRAPH_TOKEN);
    expect(request(1).token).toBe(REST_TOKEN);
    expect(describeRejectedAuth()).toEqual([expect.objectContaining({ slot: 'ows', apiBase: GRAPH_API_BASE })]);
  });
});

describe('uploadAttachmentToOneDrive', () => {
  test('skips non-Graph candidates, sends the content PUT once and replays createLink', async () => {
    fetchMock
      .mockResolvedValueOnce(json(201, { id: 'item-1' }))
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(json(200, { link: { webUrl: 'https://contoso-my.sharepoint.com/:b:/g/personal/x' } }));

    const webUrl = await settled(uploadAttachmentToOneDrive('report.pdf', new Uint8Array([1]), 'application/pdf'));
    expect(webUrl).toBe('https://contoso-my.sharepoint.com/:b:/g/personal/x');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) expect(request(i).token).toBe(GRAPH_TOKEN);
    expect(request(0).init.method).toBe('PUT');
    expect(request(0).url).toContain('/me/drive/root:/Attachments/report.pdf:/content');
    expect(request(1).init.method).toBe('POST');
    expect(request(1).url).toContain('/me/drive/items/item-1/createLink');
    expect(request(2).url).toContain('/me/drive/items/item-1/createLink');
    expect(describeCachedAuth()).toEqual([expect.objectContaining({ slot: 'files', apiBase: GRAPH_API_BASE })]);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('does not replay the content PUT on a plain 503', async () => {
    fetchMock.mockResolvedValueOnce(respond(503));
    const error = await rejection(uploadAttachmentToOneDrive('report.pdf', new Uint8Array([1]), 'application/pdf'));
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', category: 'internal', retryable: true });
    expect(error.message).toContain('graph.microsoft.com returned HTTP 503');
    expect(error.message).toContain('after 1 attempt.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeCachedAuth()).toEqual([]);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('replays the content PUT the front door refused before forwarding it', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL }))
      .mockResolvedValueOnce(json(201, { id: 'item-1' }))
      .mockResolvedValueOnce(json(200, { link: { webUrl: 'https://contoso-my.sharepoint.com/:b:/g/personal/x' } }));

    const webUrl = await settled(uploadAttachmentToOneDrive('report.pdf', new Uint8Array([1]), 'application/pdf'));
    expect(webUrl).toBe('https://contoso-my.sharepoint.com/:b:/g/personal/x');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(request(0).init.method).toBe('PUT');
    expect(request(1).init.method).toBe('PUT');
    expect(request(1).url).toContain('/me/drive/root:/Attachments/report.pdf:/content');
  });

  test('a Graph token without Files scope is rejected and the cascade ends with an auth error', async () => {
    fetchMock.mockResolvedValueOnce(respond(403));
    const error = await rejection(uploadAttachmentToOneDrive('report.pdf', new Uint8Array([1]), 'application/pdf'));
    expect(error.category).toBe('auth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeRejectedAuth()).toEqual([expect.objectContaining({ slot: 'files', apiBase: GRAPH_API_BASE })]);
  });
});

describe('diagnostics', () => {
  test('probeApiBase sends one unretried request with the slot token and touches no cache', async () => {
    setAuthCache(MAIL_SLOT, { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE });
    fetchMock.mockResolvedValueOnce(respond(500, { 'request-id': 'req-1', 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL }));

    const result = await settled(probeApiBase('graph'));
    expect(result).toEqual({
      name: 'graph',
      path: '/me',
      status: 500,
      ok: false,
      latencyMs: expect.any(Number),
      requestId: 'req-1',
      frontDoor: FRONT_DOOR_REFUSAL,
      error: null,
      tokenFingerprint: tokenFingerprint(GRAPH_TOKEN),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request(0).url).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\?/);
    expect(request(0).init.credentials).toBe('omit');
    expect(describeCachedAuth()).toEqual([expect.objectContaining({ slot: 'mail', apiBase: GRAPH_API_BASE })]);
    expect(describeRejectedAuth()).toEqual([]);
  });

  test('probeApiBase picks the first candidate for a base the mail slot does not trust', async () => {
    setAuthCache(MAIL_SLOT, { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE });
    fetchMock.mockResolvedValueOnce(respond(200));
    const result = await settled(probeApiBase('outlook-rest'));
    expect(result).toMatchObject({
      name: 'outlook-rest',
      status: 200,
      ok: true,
      tokenFingerprint: tokenFingerprint(REST_TOKEN),
    });
    expect(request(0).url).toBe(`${OUTLOOK_API_BASE}/me`);
  });

  test('the OWS probe is same-origin and carries the OWS routing headers', async () => {
    fetchMock.mockResolvedValueOnce(respond(200));
    await settled(probeApiBase('ows'));
    const { url, init } = request(0);
    expect(url).toBe(
      'https://outlook.cloud.microsoft/ows/v1/OutlookCloudSettings/settings/?settingname=roaming_new_signature',
    );
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['x-ms-appname']).toBe('owa-reactmail');
  });

  test('a hung API base is reported as a TimeoutError probe within PROBE_TIMEOUT_MS while the others answer', async () => {
    // Node's AbortSignal.timeout schedules on internal timers the fake clock cannot
    // reach, so the abort is rescheduled on the faked setTimeout instead.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).startsWith(GRAPH_API_BASE)) return Promise.resolve(respond(200));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });

    const probes = Promise.all([probeApiBase('graph'), probeApiBase('outlook-rest'), probeApiBase('ows')]);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const [graph, outlookRest, ows] = await probes;

    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(timeoutSpy).toHaveBeenCalledWith(PROBE_TIMEOUT_MS);
    expect(graph).toMatchObject({ name: 'graph', status: null, ok: false, requestId: null, frontDoor: null });
    expect(graph.error).toMatch(/^TimeoutError/);
    expect(graph.latencyMs).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS);
    expect(outlookRest).toMatchObject({ name: 'outlook-rest', status: 200, ok: true, error: null });
    expect(ows).toMatchObject({ name: 'ows', status: 200, ok: true, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('probeApiBase reports a missing token instead of sending anything', async () => {
    localStorage.clear();
    const result = await settled(probeApiBase('outlook-rest'));
    expect(result).toMatchObject({ status: null, ok: false, tokenFingerprint: null });
    expect(result.error).toContain('No candidate token for this API base');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('describeCachedAuth reports the expiry only for tokens cached with MSAL provenance', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await settled(api('/me'));
    setAuthCache('outlook-ows', { token: REST_TOKEN, apiBase: OUTLOOK_API_BASE });

    const cached = describeCachedAuth();
    expect(cached.find(entry => entry.slot === 'mail')?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cached.find(entry => entry.slot === 'ows')?.expiresAt).toBeNull();
    expect(JSON.stringify(cached)).not.toContain(GRAPH_TOKEN);
  });
});
