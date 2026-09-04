/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://contoso.sharepoint.com/:w:/r/sites/x/Shared%20Documents/doc.docx?d=wabc123&csf=1&web=1"}
 */
import { getCurrentUrl, ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AUTH_EXPIRED_MESSAGE,
  activeTokenSource,
  api,
  describeDocumentContextSource,
  describePageKind,
  describeTokenSources,
  FILE_LOCKED_MESSAGE,
  fetchDownloadUrl,
  graphFetch,
  NOT_AUTHENTICATED_MESSAGE,
  probeCurrentUser,
  probeSharedDocumentItem,
  readReloadMarker,
  resolveDocumentContext,
} from './microsoft-word-api.js';
import { tokenFingerprint } from './token-fingerprint.js';

// `getCurrentUrl` is swapped so tests can move the page across origins, which
// jsdom's history API forbids.
vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  getCurrentUrl: vi.fn(() => window.location.href),
}));

const SHAREPOINT_URL = 'https://contoso.sharepoint.com/:w:/r/sites/x/Shared%20Documents/doc.docx?d=wabc123&csf=1&web=1';
const CLOUD_APP_URL = 'https://word.cloud.microsoft/open/abc?driveId=drive-1&docId=item-1';
const DOWNLOAD_URL =
  'https://contoso-my.sharepoint.com/personal/x/_layouts/15/download.aspx?UniqueId=abc&tempauth=secret';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LS_TOKEN_KEY = '__opentabs_word_graph_token';
const MSAL_KEYS_KEY = 'msal.token.keys.2821b473-fe24-4c86-ba16-62834d6e80c3';
const MSAL_TOKEN_KEY =
  'uid.tenant-login.windows.net-accesstoken-client-tenant-https://graph.microsoft.com/files.readwrite openid';
const FRONT_DOOR_LABEL = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';

const base64Url = (text: string): string => btoa(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fakeJwt = (claims: Record<string, unknown>, marker: string): string =>
  `${base64Url(JSON.stringify({ alg: 'none' }))}.${base64Url(JSON.stringify(claims))}.${marker}-signature-0123456789abcdef`;

const MIRROR_TOKEN = fakeJwt({ aud: 'https://graph.microsoft.com', scp: 'Files.ReadWrite.All' }, 'mirror');
const NAMESPACE_TOKEN = fakeJwt({ aud: 'https://graph.microsoft.com', scp: 'Files.ReadWrite.All' }, 'namespace');
const MSAL_TOKEN = fakeJwt({ aud: '00000003-0000-0000-c000-000000000000' }, 'msal');

const nowSec = (): number => Math.floor(Date.now() / 1000);

type OpenTabsGlobal = { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } };
const setNamespace = (values: Record<string, unknown> | undefined): void => {
  (globalThis as OpenTabsGlobal).__openTabs =
    values === undefined ? undefined : { preScript: { 'microsoft-word': values } };
};

const stashMirrorToken = (exp = nowSec() + 3600): void =>
  localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token: MIRROR_TOKEN, exp }));

const stashMsalToken = (expiresOn: number): void => {
  localStorage.setItem(MSAL_KEYS_KEY, JSON.stringify({ accessToken: [MSAL_TOKEN_KEY] }));
  localStorage.setItem(MSAL_TOKEN_KEY, JSON.stringify({ secret: MSAL_TOKEN, expiresOn: String(expiresOn) }));
};

const respond = (status: number, headers?: Record<string, string>, body?: unknown): Response =>
  new Response(
    body === undefined ? (status === 202 || status === 204 ? null : `body-${status}`) : JSON.stringify(body),
    {
      status,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    },
  );

/** Resolves `promise` while draining every pending timer so retry sleeps complete under fake timers. */
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  await vi.runAllTimersAsync();
  return promise;
};

/** The ToolError `promise` rejects with, settled under fake timers. */
const rejection = async (promise: Promise<unknown>): Promise<ToolError> => {
  const outcome = await settle(
    promise.then(
      () => {
        throw new Error('expected the promise to reject');
      },
      (error: unknown) => error,
    ),
  );
  expect(outcome).toBeInstanceOf(ToolError);
  return outcome as ToolError;
};

const requestInit = (call: number): RequestInit => {
  const init = fetchMock.mock.calls[call]?.[1];
  if (init === undefined) throw new Error(`fetch call ${call} was not made`);
  return init;
};
const requestUrl = (call: number): string => String(fetchMock.mock.calls[call]?.[0]);
const requestHeaders = (call: number): Record<string, string> => requestInit(call).headers as Record<string, string>;

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  stashMirrorToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(getCurrentUrl).mockReset();
  localStorage.clear();
  setNamespace(undefined);
});

describe('graphFetch — request shape', () => {
  test('sends a bearer-authenticated request with cookies omitted to the Graph v1.0 endpoint', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, undefined, { id: 'me' }));
    await settle(api('/me', { query: { $select: 'id' } }));
    expect(requestUrl(0)).toBe(`${GRAPH_BASE}/me?%24select=id`);
    expect(requestInit(0)).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(requestHeaders(0).Authorization).toBe(`Bearer ${MIRROR_TOKEN}`);
    expect(requestInit(0).signal).toBeInstanceOf(AbortSignal);
  });

  test('serializes a JSON body with its content type', async () => {
    fetchMock.mockResolvedValueOnce(respond(201, undefined, { id: 'new' }));
    const result = await settle(
      api<{ id: string }>('/me/drive/root/children', { method: 'POST', body: { name: 'x' } }),
    );
    expect(result).toEqual({ id: 'new' });
    expect(requestInit(0).body).toBe('{"name":"x"}');
    expect(requestHeaders(0)['Content-Type']).toBe('application/json');
  });

  test('sends a raw body with the given content type and returns the Response', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, undefined, { id: 'item' }));
    const body = new ArrayBuffer(4);
    const response = await settle(
      graphFetch('/me/drive/items/item-1/content', { method: 'PUT', body, contentType: 'text/plain' }),
    );
    expect(response.status).toBe(200);
    expect(requestInit(0).body).toBe(body);
    expect(requestHeaders(0)['Content-Type']).toBe('text/plain');
  });

  test.each([202, 204])('api resolves with an empty object for a bodiless %i', async status => {
    fetchMock.mockResolvedValueOnce(respond(status));
    expect(await settle(api('/me/drive/items/item-1/copy', { method: 'POST', body: {} }))).toEqual({});
  });

  test('throws AUTH_ERROR without a request when no token source is usable', async () => {
    localStorage.clear();
    const error = await rejection(api('/me'));
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain(NOT_AUTHENTICATED_MESSAGE);
    expect(error.details).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('graphFetch — transient failures', () => {
  test('retries a GET on 500 and resolves with the eventual 200', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(200, undefined, { id: 'me' }));
    expect(await settle(api('/me'))).toEqual({ id: 'me' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestHeaders(2).Authorization).toBe(`Bearer ${MIRROR_TOKEN}`);
  });

  test('throws UPSTREAM_UNAVAILABLE naming the host, status, attempts and request id after exhausting a GET', async () => {
    fetchMock.mockResolvedValue(
      respond(500, {
        'request-id': 'req-500',
        'x-proxyerrorlabel': FRONT_DOOR_LABEL,
        'x-proxyerrormessage': 'The network is busy.',
      }),
    );
    const error = await rejection(api('/me/drive/items/item-1'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("Microsoft's service front door");
    expect(error.message).toContain('graph.microsoft.com');
    expect(error.message).toContain('HTTP 500');
    expect(error.message).toContain('The network is busy.');
    expect(error.message).toContain('3 attempts');
    expect(error.message).toContain('request-id req-500');
    expect(error.message).not.toContain('item-1');
    expect(error.details).toEqual({
      httpStatus: 500,
      attempts: 3,
      requestId: 'req-500',
      frontDoorLabel: FRONT_DOOR_LABEL,
    });
  });

  test('quotes the Graph error envelope of the last transient response', async () => {
    // A fresh Response per attempt: fetchWithRetry cancels each retried body and the message reads the last one.
    fetchMock.mockImplementation(async () =>
      respond(503, undefined, { error: { code: 'ServiceUnavailable', message: 'Try later' } }),
    );
    const error = await rejection(api('/me'));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('ServiceUnavailable: Try later');
  });

  test('does not replay a POST on 500 and reports a single attempt', async () => {
    fetchMock.mockResolvedValue(respond(500, { 'request-id': 'req-post' }));
    const error = await rejection(api('/me/drive/root/children', { method: 'POST', body: { name: 'f' } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 1 attempt;');
    expect(error.message).toContain('request-id req-post');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 1, requestId: 'req-post' });
  });

  test('replays a POST the front door refused before forwarding it', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_LABEL }))
      .mockResolvedValueOnce(respond(201, undefined, { id: 'created' }));
    expect(await settle(api('/me/drive/root/children', { method: 'POST', body: { name: 'f' } }))).toEqual({
      id: 'created',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('reports three attempts when the front door refused a POST every time', async () => {
    fetchMock.mockImplementation(async () => respond(503, { 'x-proxyerrorlabel': FRONT_DOOR_LABEL }));
    const error = await rejection(api('/me/drive/root/children', { method: 'POST', body: { name: 'f' } }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 3 attempts');
  });

  test('does not replay a PUT on 500 by default', async () => {
    fetchMock.mockResolvedValue(respond(502));
    const error = await rejection(
      graphFetch('/me/drive/items/item-1/content', { method: 'PUT', body: 'x', contentType: 'text/plain' }),
    );
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports a single attempt for a plain 503 on a PUT without the replay opt-in', async () => {
    fetchMock.mockResolvedValue(respond(503, { 'request-id': 'req-put' }));
    const error = await rejection(
      graphFetch('/me/drive/items/item-1/content', { method: 'PUT', body: 'x', contentType: 'text/plain' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('graph.microsoft.com returned HTTP 503 after 1 attempt;');
    expect(error.message).toContain('request-id req-put');
  });

  test('reports a single attempt when a 503 Retry-After above the wait cap ends the retries', async () => {
    fetchMock.mockResolvedValue(respond(503, { 'Retry-After': '30' }));
    const error = await rejection(api('/me'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toContain('after 1 attempt.');
  });

  test('replays a PUT with retryNonIdempotent, sending the identical body and content type each time', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200, undefined, { id: 'item' }));
    const body = new ArrayBuffer(8);
    const response = await settle(
      graphFetch('/me/drive/items/item-1/content', {
        method: 'PUT',
        body,
        contentType: 'application/octet-stream',
        retryNonIdempotent: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestInit(0).body).toBe(body);
    expect(requestInit(1).body).toBe(body);
    expect(requestHeaders(1)['Content-Type']).toBe('application/octet-stream');
  });

  test('retries a GET on a connection failure and resolves when the network recovers', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(respond(200, undefined, { id: 'me' }));
    expect(await settle(api('/me'))).toEqual({ id: 'me' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('throws NETWORK_ERROR after exhausting connection failures on a GET', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(api('/me/drive/items/item-1'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Network error reaching graph.microsoft.com after 3 attempts: Failed to fetch');
    expect(error.details).toEqual({ attempts: 3 });
  });

  test('throws NETWORK_ERROR after one connection failure on a POST', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(api('/me/drive/root/children', { method: 'POST', body: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('after 1 attempt:');
    expect(error.details).toEqual({ attempts: 1 });
  });

  test('maps the request timeout to TIMEOUT without retrying', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const error = await rejection(api('/me'));
    expect(error.code).toBe('TIMEOUT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('honors a short Retry-After on 429 and resolves with the eventual 200', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(respond(200, undefined, { id: 'me' }));
    const request = api('/me');
    // The exponential backoff for a first retry would have fired well before
    // 999 ms; the retry waiting on the header's full second proves it won.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await settle(request)).toEqual({ id: 'me' });
  });

  test('throws RATE_LIMITED immediately for a 429 whose Retry-After exceeds the wait cap', async () => {
    fetchMock.mockResolvedValue(respond(429, { 'Retry-After': '30', 'request-id': 'req-429' }));
    const error = await rejection(api('/me'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toContain('request-id req-429');
    expect(error.details).toEqual({ httpStatus: 429, requestId: 'req-429' });
  });

  test.each([501, 505])('throws INTERNAL_ERROR for %i without retrying', async status => {
    fetchMock.mockResolvedValue(respond(status));
    const error = await rejection(api('/me'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toContain(`Microsoft Graph API error (${status})`);
    expect(error.details).toEqual({ httpStatus: status });
  });
});

describe('graphFetch — status classification', () => {
  test.each([401, 403])('maps %i to AUTH_ERROR with the request id and the SharePoint reauth hint', async status => {
    fetchMock.mockResolvedValue(respond(status, { 'request-id': 'req-auth' }));
    const error = await rejection(api('/me'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain(AUTH_EXPIRED_MESSAGE);
    expect(error.message).toContain('(request-id req-auth)');
    expect(error.message.endsWith('Call `microsoft-word__reauthenticate` to recover.')).toBe(true);
    expect(error.details).toEqual({ httpStatus: status, requestId: 'req-auth' });
  });

  test('omits the reauth hint on the standalone app', async () => {
    vi.mocked(getCurrentUrl).mockReturnValue(CLOUD_APP_URL);
    fetchMock.mockResolvedValue(respond(401));
    const error = await rejection(api('/me'));
    expect(error.message).toBe(AUTH_EXPIRED_MESSAGE);
  });

  test('maps 404 to NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(respond(404, { 'x-ms-request-id': 'req-404' }));
    const error = await rejection(api('/me/drive/items/missing'));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('request-id req-404');
    expect(error.details).toEqual({ httpStatus: 404, requestId: 'req-404' });
  });

  test('maps 423 on a content PUT to VALIDATION_ERROR with the lock guidance after one request', async () => {
    fetchMock.mockResolvedValue(respond(423));
    const error = await rejection(
      graphFetch('/me/drive/items/item-1/content', {
        method: 'PUT',
        body: 'x',
        contentType: 'text/plain',
        retryNonIdempotent: true,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain(FILE_LOCKED_MESSAGE);
    expect(error.details).toEqual({ httpStatus: 423 });
  });

  test.each([400, 409, 422])('maps %i to VALIDATION_ERROR carrying the Graph error message', async status => {
    fetchMock.mockResolvedValue(
      respond(status, { 'request-id': 'req-val' }, { error: { code: 'invalidRequest', message: 'Bad name' } }),
    );
    const error = await rejection(api('/me/drive/root/children', { method: 'POST', body: {} }));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Bad name (request-id req-val)');
    expect(error.details).toEqual({ httpStatus: status, requestId: 'req-val' });
  });

  test('falls back to a status-based INTERNAL_ERROR message when the body is not a Graph envelope', async () => {
    fetchMock.mockResolvedValue(respond(418));
    const error = await rejection(api('/me'));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Microsoft Graph API error (418)');
    expect(error.details).toEqual({ httpStatus: 418 });
  });
});

describe('fetchDownloadUrl', () => {
  test('sends an unauthenticated GET with cookies omitted', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bytes', { status: 200 }));
    const response = await settle(fetchDownloadUrl(DOWNLOAD_URL));
    expect(await response.text()).toBe('bytes');
    expect(requestUrl(0)).toBe(DOWNLOAD_URL);
    expect(requestInit(0)).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(requestInit(0).headers).toBeUndefined();
  });

  test('retries a 503 and resolves with the eventual 200', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(new Response('bytes', { status: 200 }));
    const response = await settle(fetchDownloadUrl(DOWNLOAD_URL));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('throws UPSTREAM_UNAVAILABLE naming only the download host after exhausting retries', async () => {
    fetchMock.mockResolvedValue(respond(503, { 'request-id': 'req-dl' }));
    const error = await rejection(fetchDownloadUrl(DOWNLOAD_URL));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('contoso-my.sharepoint.com returned HTTP 503');
    expect(error.message).toContain('request-id req-dl');
    expect(error.message).not.toContain('tempauth');
    expect(error.message).not.toContain('download.aspx');
    expect(error.details).toEqual({ httpStatus: 503, attempts: 3, requestId: 'req-dl' });
  });

  test('reports the attempts observed when a long Retry-After ends the retries after one request', async () => {
    fetchMock.mockResolvedValue(respond(503, { 'Retry-After': '30' }));
    const error = await rejection(fetchDownloadUrl(DOWNLOAD_URL));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toContain('after 1 attempt.');
  });

  test('throws INTERNAL_ERROR for a non-transient failure after one request', async () => {
    fetchMock.mockResolvedValue(respond(403));
    const error = await rejection(fetchDownloadUrl(DOWNLOAD_URL));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('File download failed (403).');
    expect(error.details).toEqual({ httpStatus: 403 });
  });

  test('maps the request timeout to TIMEOUT', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const error = await rejection(fetchDownloadUrl(DOWNLOAD_URL));
    expect(error.code).toBe('TIMEOUT');
  });
});

describe('token sources', () => {
  test('describes every source without exposing a token value', () => {
    setNamespace({ graph: { token: NAMESPACE_TOKEN, exp: nowSec() + 1800 }, graphCapturedAt: Date.now() - 90_000 });
    stashMsalToken(nowSec() - 60);

    const sources = describeTokenSources();
    const serialized = JSON.stringify(sources);
    for (const token of [NAMESPACE_TOKEN, MIRROR_TOKEN, MSAL_TOKEN]) expect(serialized).not.toContain(token);

    expect(sources.map(s => s.source)).toEqual(['preScript', 'localStorageMirror', 'msalPlaintext']);
    expect(sources[0]).toEqual({
      source: 'preScript',
      present: true,
      expiresInSec: 1800,
      audience: 'graph.microsoft.com',
      fingerprint: tokenFingerprint(NAMESPACE_TOKEN),
      capturedAgoSec: 90,
    });
    expect(sources[1]).toMatchObject({
      source: 'localStorageMirror',
      present: true,
      expiresInSec: 3600,
      audience: 'graph.microsoft.com',
      fingerprint: tokenFingerprint(MIRROR_TOKEN),
      capturedAgoSec: null,
    });
    expect(sources[2]).toMatchObject({
      source: 'msalPlaintext',
      present: true,
      expiresInSec: -60,
      audience: '00000003-0000-0000-c000-000000000000',
      fingerprint: tokenFingerprint(MSAL_TOKEN),
    });
  });

  test('reports absent sources with null fields', () => {
    localStorage.clear();
    for (const source of describeTokenSources()) {
      expect(source).toMatchObject({
        present: false,
        expiresInSec: null,
        audience: null,
        fingerprint: null,
        capturedAgoSec: null,
      });
    }
    expect(activeTokenSource()).toBeNull();
  });

  test('fingerprints are four hex characters and differ between tokens', () => {
    expect(tokenFingerprint(MIRROR_TOKEN)).toMatch(/^[0-9a-f]{4}$/);
    expect(tokenFingerprint(MIRROR_TOKEN)).not.toBe(tokenFingerprint(NAMESPACE_TOKEN));
    expect(tokenFingerprint(MIRROR_TOKEN)).toBe(tokenFingerprint(MIRROR_TOKEN));
  });

  test('the active source is the first one holding a usable token', async () => {
    expect(activeTokenSource()).toBe('localStorageMirror');
    setNamespace({ graph: { token: NAMESPACE_TOKEN, exp: nowSec() + 1800 } });
    expect(activeTokenSource()).toBe('preScript');
    fetchMock.mockResolvedValueOnce(respond(200, undefined, { id: 'me' }));
    await settle(api('/me'));
    expect(requestHeaders(0).Authorization).toBe(`Bearer ${NAMESPACE_TOKEN}`);
  });

  test('a token within 30 seconds of expiry is present but not usable', () => {
    stashMirrorToken(nowSec() + 10);
    expect(describeTokenSources()[1]).toMatchObject({ present: true, expiresInSec: 10 });
    expect(activeTokenSource()).toBeNull();
  });

  test('an expired MSAL entry is reported but a live one is preferred for requests', () => {
    localStorage.clear();
    stashMsalToken(nowSec() - 5);
    expect(activeTokenSource()).toBeNull();
    stashMsalToken(nowSec() + 900);
    expect(activeTokenSource()).toBe('msalPlaintext');
  });
});

describe('page and document context', () => {
  test('classifies the SharePoint document, the standalone app and any other page', () => {
    expect(describePageKind()).toBe('sharepoint');
    expect(describeDocumentContextSource()).toBe('shares');

    vi.mocked(getCurrentUrl).mockReturnValue(CLOUD_APP_URL);
    expect(describePageKind()).toBe('cloud-app');
    expect(describeDocumentContextSource()).toBe('url');

    vi.mocked(getCurrentUrl).mockReturnValue('https://word.cloud.microsoft/');
    expect(describePageKind()).toBe('cloud-app');
    expect(describeDocumentContextSource()).toBeNull();

    vi.mocked(getCurrentUrl).mockReturnValue('https://example.com/');
    expect(describePageKind()).toBe('other');
  });

  test('resolves a SharePoint document through /shares and caches the result per URL', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, undefined, { id: 'item-9', parentReference: { driveId: 'drive-9' } }));
    expect(await settle(resolveDocumentContext())).toEqual({ driveId: 'drive-9', itemId: 'item-9' });
    expect(requestUrl(0)).toBe(
      `${GRAPH_BASE}/shares/u!${base64Url(SHAREPOINT_URL)}/driveItem?%24select=id%2CparentReference`,
    );

    expect(await settle(resolveDocumentContext())).toEqual({ driveId: 'drive-9', itemId: 'item-9' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reads document ids from the standalone app URL without a request', async () => {
    vi.mocked(getCurrentUrl).mockReturnValue(CLOUD_APP_URL);
    expect(await settle(resolveDocumentContext())).toEqual({ driveId: 'drive-1', itemId: 'item-1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('readReloadMarker', () => {
  test('prefers the marker the pre-script captured', () => {
    const captured = { reason: 'SessionExpired', count: 2, subcode: 'abc', capturedAt: 123 };
    setNamespace({ reloadMarker: captured });
    vi.mocked(getCurrentUrl).mockReturnValue(`${SHAREPOINT_URL}&wdrldr=Other`);
    expect(readReloadMarker()).toEqual(captured);
  });

  test('falls back to the current URL and returns null when neither carries a marker', () => {
    expect(readReloadMarker()).toBeNull();
    vi.mocked(getCurrentUrl).mockReturnValue(`${SHAREPOINT_URL}&wdrldr=Reload&wdrldc=1`);
    expect(readReloadMarker()).toMatchObject({ reason: 'Reload', count: 1, subcode: null });
  });
});

describe('probes', () => {
  test('probeCurrentUser issues exactly one unretried request and records the raw outcome', async () => {
    fetchMock.mockResolvedValue(respond(500, { 'request-id': 'req-probe', 'x-proxyerrorlabel': FRONT_DOOR_LABEL }));
    const result = await settle(probeCurrentUser());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(0)).toBe(`${GRAPH_BASE}/me?%24select=id`);
    expect(requestInit(0)).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(requestHeaders(0).Authorization).toBe(`Bearer ${MIRROR_TOKEN}`);
    expect(result).toMatchObject({
      name: 'graph:/me',
      path: '/me',
      status: 500,
      ok: false,
      requestId: 'req-probe',
      frontDoor: FRONT_DOOR_LABEL,
      error: null,
    });
  });

  test('a probe without a usable token records the auth error instead of sending a request', async () => {
    localStorage.clear();
    const result = await settle(probeCurrentUser());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: null, ok: false, requestId: null });
    expect(result.error).toContain(NOT_AUTHENTICATED_MESSAGE);
  });

  test('probeSharedDocumentItem records a path template, never the encoded share id', async () => {
    fetchMock.mockResolvedValue(respond(200, undefined, { id: 'item-9' }));
    const result = await settle(probeSharedDocumentItem());
    expect(requestUrl(0)).toContain(`/shares/u!${base64Url(SHAREPOINT_URL)}/driveItem`);
    expect(result).toMatchObject({ name: 'graph:/shares', path: '/shares/{shareId}/driveItem', status: 200, ok: true });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('u!');
    expect(serialized).not.toContain(base64Url(SHAREPOINT_URL));
    expect(serialized).not.toContain('doc.docx');
  });
});
