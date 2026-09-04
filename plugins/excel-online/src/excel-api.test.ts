/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://excel.cloud.microsoft/open/onedrive/?driveId=drive-1&docId=item-1"}
 */
import { getCurrentUrl, ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  activeTokenSource,
  api,
  describeTokenSources,
  GRAPH_TOKEN_SOURCES,
  isAuthenticated,
  locateWorkbook,
  probeGraph,
  probeWorkbookShare,
  readReloadMarker,
  workbookApi,
  workbookBatch,
} from './excel-api.js';

// `getCurrentUrl` is mocked so single tests can stand on a SharePoint URL —
// jsdom refuses a cross-origin replaceState. Retries are observed through the
// number of fetch calls: the SDK's retry loop logs through its own module-
// internal `log`, which a mock of the package barrel cannot reach.
vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  getCurrentUrl: vi.fn((): string => location.href),
}));

const CLOUD_APP_URL = 'https://excel.cloud.microsoft/open/onedrive/?driveId=drive-1&docId=item-1';
const SHAREPOINT_URL = 'https://contoso.sharepoint.com/:x:/r/sites/finance/Shared%20Documents/Book.xlsx?web=1';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const WORKBOOK_PREFIX = '/drives/drive-1/items/item-1/workbook';
const REDACTED_WORKBOOK_PREFIX = '/drives/{driveId}/items/{itemId}/workbook';
const LS_TOKEN_KEY = '__opentabs_excel_graph_token';
const FRONT_DOOR_REFUSAL = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';

const base64url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const nowSec = (): number => Math.floor(Date.now() / 1000);

const fakeJwt = (label: string, claims: Record<string, unknown> = {}): string =>
  `${base64url('{"alg":"RS256"}')}.${base64url(
    JSON.stringify({
      aud: 'https://graph.microsoft.com',
      scp: 'Files.ReadWrite.All Sites.ReadWrite.All',
      label,
      ...claims,
    }),
  )}.sig-${label}`;

const setPreScriptNamespace = (values: Record<string, unknown> | undefined): void => {
  Object.assign(globalThis, {
    __openTabs: values === undefined ? undefined : { preScript: { 'excel-online': values } },
  });
};

const stubMirrorToken = (token: string, exp = nowSec() + 3600): void => {
  localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token, exp }));
};

const stubMsalToken = (token: string, expiresOn: string = String(nowSec() + 3600)): void => {
  localStorage.setItem(
    'uid.tid-login.windows.net-accesstoken-client-1-tid-https://graph.microsoft.com/files.readwrite.all--',
    JSON.stringify({ secret: token, expiresOn, credentialType: 'AccessToken' }),
  );
};

const respond = (status: number, headers?: Record<string, string>, body: BodyInit | null = null): Response =>
  new Response(body, { status, headers });

const json = (status: number, payload: unknown, headers?: Record<string, string>): Response =>
  respond(status, { 'content-type': 'application/json; odata.metadata=minimal', ...headers }, JSON.stringify(payload));

/**
 * Resolves `promise` while draining every pending timer so retry sleeps complete
 * under fake timers. The outcome is captured before the timers run so a promise
 * that rejects synchronously is never reported as an unhandled rejection.
 */
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  const outcome = promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if (result.ok) return result.value;
  throw result.error;
};

const rejection = async (promise: Promise<unknown>): Promise<ToolError> => {
  try {
    await settle(promise);
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw new Error(`expected a ToolError, got ${String(error)}`);
  }
  throw new Error('expected the promise to reject');
};

const requestAt = (index: number): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch call ${index} was not made`);
  const [input, init] = call;
  return { url: String(input), init: init ?? {} };
};

const headerOf = (init: RequestInit, name: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[name];

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getCurrentUrl).mockImplementation(() => location.href);
  localStorage.clear();
  setPreScriptNamespace(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('token sources', () => {
  test('rejects with AUTH_ERROR and no request when no source holds a token', async () => {
    const error = await rejection(api('/me'));
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain('Not authenticated');
    expect(error.message).not.toContain('reauthenticate');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(false);
    expect(activeTokenSource()).toBeNull();
  });

  test('prefers the pre-script namespace, then the localStorage mirror, then the MSAL plaintext cache', async () => {
    stubMsalToken(fakeJwt('msal'));
    expect(activeTokenSource()).toBe('msalPlaintext');
    stubMirrorToken(fakeJwt('mirror'));
    expect(activeTokenSource()).toBe('localStorageMirror');
    setPreScriptNamespace({ graph: { token: fakeJwt('namespace'), exp: nowSec() + 3600 } });
    expect(activeTokenSource()).toBe('preScript');

    fetchMock.mockResolvedValueOnce(json(200, { id: 'me' }));
    await settle(api('/me'));
    expect(headerOf(requestAt(0).init, 'Authorization')).toBe(`Bearer ${fakeJwt('namespace')}`);
  });

  test('skips a token that expires within 30 seconds and one whose MSAL expiry is unreadable', () => {
    stubMirrorToken(fakeJwt('mirror'), nowSec() + 10);
    expect(activeTokenSource()).toBeNull();
    stubMsalToken(fakeJwt('msal'), 'not-a-number');
    expect(activeTokenSource()).toBeNull();
    stubMsalToken(fakeJwt('msal'));
    expect(activeTokenSource()).toBe('msalPlaintext');
  });

  test('describes every source without exposing a token', () => {
    const namespaceToken = fakeJwt('namespace');
    const mirrorToken = fakeJwt('mirror', { aud: '00000003-0000-0000-c000-000000000000', scp: 'Files.Read' });
    setPreScriptNamespace({
      graph: { token: namespaceToken, exp: nowSec() + 3600 },
      graphCapturedAt: Date.now() - 90_000,
    });
    stubMirrorToken(mirrorToken, nowSec() - 60);

    const sources = describeTokenSources();
    expect(sources.map(source => source.source)).toEqual([...GRAPH_TOKEN_SOURCES]);
    expect(sources[0]).toEqual({
      source: 'preScript',
      present: true,
      expiresInSec: 3600,
      audience: 'graph.microsoft.com',
      scopes: ['Files.ReadWrite.All', 'Sites.ReadWrite.All'],
      fingerprint: expect.stringMatching(/^[0-9a-f]{4}$/),
      capturedAgoSec: 90,
    });
    expect(sources[1]).toEqual({
      source: 'localStorageMirror',
      present: true,
      expiresInSec: -60,
      audience: '00000003-0000-0000-c000-000000000000',
      scopes: ['Files.Read'],
      fingerprint: expect.stringMatching(/^[0-9a-f]{4}$/),
      capturedAgoSec: null,
    });
    expect(sources[2]).toEqual({
      source: 'msalPlaintext',
      present: false,
      expiresInSec: null,
      audience: null,
      scopes: [],
      fingerprint: null,
      capturedAgoSec: null,
    });
    const serialized = JSON.stringify(sources);
    expect(serialized).not.toContain(namespaceToken);
    expect(serialized).not.toContain(mirrorToken);
    expect(serialized).not.toContain('sig-');
  });

  test('describes an opaque (non-JWT) token with null audience and no scopes', () => {
    stubMsalToken('EwB4A8l6BAAUopaque');
    const [, , msal] = describeTokenSources();
    expect(msal).toMatchObject({ present: true, audience: null, scopes: [], fingerprint: expect.any(String) });
  });

  test('ignores a malformed mirror entry', () => {
    localStorage.setItem(LS_TOKEN_KEY, '{not json');
    expect(describeTokenSources()[1]?.present).toBe(false);
    localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token: '', exp: 'soon' }));
    expect(describeTokenSources()[1]?.present).toBe(false);
  });
});

describe('graph requests', () => {
  beforeEach(() => {
    stubMirrorToken(fakeJwt('mirror'));
  });

  test('sends bearer auth without cookies and a timeout signal, and decodes JSON', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'me' }));
    await expect(settle(api<{ id: string }>('/me', { query: { $select: 'id' } }))).resolves.toEqual({ id: 'me' });
    const { url, init } = requestAt(0);
    expect(url).toBe(`${GRAPH_BASE}/me?%24select=id`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(headerOf(init, 'Authorization')).toBe(`Bearer ${fakeJwt('mirror')}`);
    expect(headerOf(init, 'Content-Type')).toBeUndefined();
  });

  test('serializes a JSON body with its content type on every attempt', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(204));
    await expect(settle(api('/x', { method: 'POST', body: { a: 1 }, retryNonIdempotent: true }))).resolves.toEqual({});
    for (const index of [0, 1]) {
      const { init } = requestAt(index);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{"a":1}');
      expect(headerOf(init, 'Content-Type')).toBe('application/json');
    }
  });

  test('retries a GET on transient statuses and returns the eventual success', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(502))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(settle(api('/me'))).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('classifies an exhausted GET as UPSTREAM_UNAVAILABLE with host, status, attempts and request id — never the path', async () => {
    // A fresh Response per attempt, as real fetch returns: the retry loop cancels
    // the body of every attempt it replays, and only the last one is classified.
    fetchMock.mockImplementation(async () =>
      json(
        500,
        { error: { code: 'generalException', message: 'The network is busy.' } },
        {
          'request-id': 'req-500',
          'x-proxyerrorlabel': FRONT_DOOR_REFUSAL,
          'x-proxyerrormessage': 'The network is busy.',
        },
      ),
    );
    const error = await rejection(api('/drives/drive-1/items/item-1/workbook/worksheets'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("Microsoft's service front door");
    expect(error.message).toContain('graph.microsoft.com');
    expect(error.message).toContain('HTTP 500');
    expect(error.message).toContain('3 attempts');
    expect(error.message).toContain('request-id req-500');
    expect(error.message).toContain('generalException');
    expect(error.message).not.toContain('item-1');
    expect(error.message).not.toContain('/worksheets');
    expect(error.details).toEqual({
      httpStatus: 500,
      attempts: 3,
      requestId: 'req-500',
      frontDoorLabel: FRONT_DOOR_REFUSAL,
    });
  });

  test('does not replay a POST on a transient status and reports the single attempt', async () => {
    fetchMock.mockResolvedValue(respond(500, { 'x-ms-request-id': 'ms-1' }));
    const error = await rejection(api(`${WORKBOOK_PREFIX}/worksheets`, { method: 'POST', body: { name: 'New' } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('after 1 attempt;');
    expect(error.message).not.toContain('attempts');
    expect(error.message).toContain('request-id ms-1');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 1, requestId: 'ms-1' });
  });

  test('reports the observed attempt count: a 3x front-door-refused POST says "after 3 attempts"', async () => {
    fetchMock.mockImplementation(async () =>
      respond(503, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL, 'request-id': 'fd-3' }),
    );
    const error = await rejection(api(`${WORKBOOK_PREFIX}/worksheets`, { method: 'POST', body: { name: 'New' } }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain("Microsoft's service front door");
    expect(error.message).toContain('after 3 attempts');
    expect(error.message).toContain('request-id fd-3');
  });

  test('reports the observed attempt count: a plain 503 on a non-replayable PUT says "after 1 attempt"', async () => {
    fetchMock.mockResolvedValue(respond(503, { 'request-id': 'put-1' }));
    const error = await rejection(api('/drives/drive-1/items/item-1/content', { method: 'PUT', body: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 1 attempt;');
    expect(error.message).not.toContain('attempts');
  });

  test('counts the attempts actually sent when a long Retry-After ends a replayable request early', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(503, { 'Retry-After': '30', 'request-id': 'ra-2' }));
    const error = await rejection(api('/me'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 2 attempts');
    expect(error.retryAfterMs).toBe(30_000);
  });

  test('does not replay a PATCH or DELETE without the idempotent opt-in', async () => {
    fetchMock.mockResolvedValue(respond(503));
    await rejection(api('/x', { method: 'PATCH', body: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await rejection(api('/x', { method: 'DELETE' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('replays a POST the caller marked idempotent', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(204));
    await expect(settle(api('/x/clear', { method: 'POST', body: {}, retryNonIdempotent: true }))).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('replays a POST the front door refused before forwarding it, even without the opt-in', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL }))
      .mockResolvedValueOnce(json(201, { id: 'ws' }));
    await expect(settle(api('/x/worksheets', { method: 'POST', body: {} }))).resolves.toEqual({ id: 'ws' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not replay a POST that failed at a later front-door stage', async () => {
    fetchMock.mockResolvedValue(
      respond(500, { 'x-proxyerrorlabel': 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpResponse' }),
    );
    const error = await rejection(api('/x/worksheets', { method: 'POST', body: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 1 attempt.');
  });

  test('recodes an exhausted network failure on a GET as NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(api('/me'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Network error reaching graph.microsoft.com after 3 attempts: Failed to fetch');
    expect(error.details).toEqual({ attempts: 3 });
  });

  test('recodes a network failure on a POST after a single attempt', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(api('/x', { method: 'POST', body: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe('Network error reaching graph.microsoft.com after 1 attempt: Failed to fetch');
  });

  test('waits out a short Retry-After on 429 before replaying and then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '2' })).mockResolvedValueOnce(json(200, { ok: 1 }));
    const request = api('/me');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(settle(request)).resolves.toEqual({ ok: 1 });
  });

  test('surfaces a long Retry-After as RATE_LIMITED after one attempt, naming the redacted endpoint', async () => {
    fetchMock.mockResolvedValue(respond(429, { 'Retry-After': '30', 'request-id': 'r-429' }, 'slow down'));
    const error = await rejection(api(`${WORKBOOK_PREFIX}/tables('Sales')/rows`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toContain(`Rate limited: ${REDACTED_WORKBOOK_PREFIX}/tables('Sales')/rows — slow down`);
    expect(error.message).toContain('request-id r-429');
    expect(error.message).not.toContain('drive-1');
    expect(error.message).not.toContain('item-1');
    expect(error.details).toEqual({ httpStatus: 429, requestId: 'r-429' });
  });

  test.each([
    [401, 'AUTH_ERROR'],
    [403, 'AUTH_ERROR'],
    [404, 'NOT_FOUND'],
    [400, 'VALIDATION_ERROR'],
    [422, 'VALIDATION_ERROR'],
    [409, 'INTERNAL_ERROR'],
    [501, 'INTERNAL_ERROR'],
    [505, 'INTERNAL_ERROR'],
  ])('classifies %i as %s after a single attempt, carrying the request id but no workbook ids', async (status, code) => {
    fetchMock.mockResolvedValue(respond(status, { 'client-request-id': 'c-1' }, `body-${status}`));
    const error = await rejection(api(`${WORKBOOK_PREFIX}/tables('Sales')`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(`body-${status}`);
    expect(error.message).toContain('(request-id c-1)');
    expect(error.message).not.toContain('drive-1');
    expect(error.message).not.toContain('item-1');
    expect(error.details).toEqual({ httpStatus: status, requestId: 'c-1' });
  });

  test('omits requestId from the details when the response exposes none', async () => {
    fetchMock.mockResolvedValue(respond(400, undefined, 'bad request'));
    const error = await rejection(api(`${WORKBOOK_PREFIX}/tables('Sales')`));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).not.toContain('request-id');
    expect(error.details).toEqual({ httpStatus: 400 });
  });

  test('names the workbook-relative resource of a 404 without the drive or item id', async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: 'ItemNotFound', message: 'Worksheet not found' } }));
    const error = await rejection(workbookApi("/worksheets('Nope')"));
    expect(requestAt(0).url).toBe(`${GRAPH_BASE}${WORKBOOK_PREFIX}/worksheets('Nope')`);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain(`Not found: ${REDACTED_WORKBOOK_PREFIX}/worksheets('Nope') — `);
    expect(error.message).toContain('ItemNotFound');
    expect(error.message).not.toContain('drive-1');
    expect(error.message).not.toContain('item-1');
    expect(error.details).toEqual({ httpStatus: 404 });
  });

  test('keeps the sharing URL out of a failed /shares resolution on a SharePoint workbook', async () => {
    vi.mocked(getCurrentUrl).mockReturnValue(SHAREPOINT_URL);
    fetchMock.mockResolvedValue(
      json(404, { error: { code: 'itemNotFound', message: 'The resource could not be found.' } }),
    );
    const error = await rejection(workbookApi('/worksheets'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAt(0).url).toMatch(/\/shares\/u!.+\/driveItem\?%24select=id%2CparentReference$/);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('Not found: /shares/{shareId}/driveItem — ');
    expect(error.message).toContain('itemNotFound');
    expect(error.message).not.toContain('u!');
    expect(error.message).not.toContain('contoso');
    expect(error.message).not.toContain('Book.xlsx');
  });

  test('points a SharePoint auth failure at excel-online__reauthenticate', async () => {
    vi.mocked(getCurrentUrl).mockReturnValue(SHAREPOINT_URL);
    fetchMock.mockResolvedValue(respond(401));
    const error = await rejection(api('/me'));
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain('Call `excel-online__reauthenticate` to recover.');
  });

  test('maps a fetch timeout to TIMEOUT without retrying, naming the redacted endpoint', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const error = await rejection(api(`${WORKBOOK_PREFIX}/worksheets`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('TIMEOUT');
    expect(error.category).toBe('timeout');
    expect(error.message).toBe(`API request timed out: ${REDACTED_WORKBOOK_PREFIX}/worksheets`);
  });

  test('rethrows an unexpected non-network failure untouched', async () => {
    const boom = new RangeError('boom');
    fetchMock.mockRejectedValue(boom);
    await expect(settle(api('/me'))).rejects.toBe(boom);
  });
});

describe('workbookBatch', () => {
  beforeEach(() => {
    stubMirrorToken(fakeJwt('mirror'));
  });

  test('resolves the workbook from the driveId/docId query and threads idempotent into the single-request path', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(204));
    const applied = await settle(
      workbookBatch([{ method: 'POST', path: '/x/format/autofitColumns', body: {} }], { retryNonIdempotent: true }),
    );
    expect(applied).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(0).url).toBe(`${GRAPH_BASE}${WORKBOOK_PREFIX}/x/format/autofitColumns`);
    expect(requestAt(0).init.method).toBe('POST');
  });

  test('does not replay the single request of a non-idempotent batch', async () => {
    fetchMock.mockResolvedValue(respond(503));
    const error = await rejection(
      workbookBatch([{ method: 'POST', path: '/tables/add', body: {} }], { retryNonIdempotent: false }),
    );
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('runs sessionless when createSession fails transiently, without replaying createSession', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(
      json(200, {
        responses: [
          { id: '1', status: 200 },
          { id: '2', status: 200 },
        ],
      }),
    );
    const requests = [
      { method: 'PATCH', path: '/a', body: { columnWidth: 1 } },
      { method: 'PATCH', path: '/b', body: { rowHeight: 2 } },
    ];
    const onChunkComplete = vi.fn();
    await expect(settle(workbookBatch(requests, { retryNonIdempotent: true, onChunkComplete }))).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(0).url).toBe(`${GRAPH_BASE}${WORKBOOK_PREFIX}/createSession`);
    expect(requestAt(1).url).toBe(`${GRAPH_BASE}/$batch`);
    const payload = JSON.parse(String(requestAt(1).init.body)) as {
      requests: { id: string; url: string; dependsOn?: string[]; headers: Record<string, string> }[];
    };
    expect(payload.requests.map(request => request.url)).toEqual([`${WORKBOOK_PREFIX}/a`, `${WORKBOOK_PREFIX}/b`]);
    expect(payload.requests[1]?.dependsOn).toEqual(['1']);
    expect(payload.requests[0]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(onChunkComplete).toHaveBeenCalledWith(2, 2);
  });

  test('replays an idempotent $batch inside a session and always closes the session', async () => {
    fetchMock
      .mockResolvedValueOnce(json(201, { id: 'session-1' }))
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(
        json(200, {
          responses: [
            { id: '1', status: 200 },
            { id: '2', status: 200 },
          ],
        }),
      )
      .mockResolvedValueOnce(respond(204));
    const requests = [
      { method: 'PATCH', path: '/a', body: {} },
      { method: 'PATCH', path: '/b', body: {} },
    ];
    await expect(settle(workbookBatch(requests, { retryNonIdempotent: true }))).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const payload = JSON.parse(String(requestAt(1).init.body)) as { requests: { headers: Record<string, string> }[] };
    expect(payload.requests[0]?.headers['workbook-session-id']).toBe('session-1');
    expect(requestAt(3).url).toBe(`${GRAPH_BASE}${WORKBOOK_PREFIX}/closeSession`);
    expect(headerOf(requestAt(3).init, 'workbook-session-id')).toBe('session-1');
  });

  test('does not replay a non-idempotent $batch and still closes the session', async () => {
    fetchMock
      .mockResolvedValueOnce(json(201, { id: 'session-1' }))
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(204));
    const requests = [
      { method: 'POST', path: '/worksheets', body: {} },
      { method: 'POST', path: '/tables/add', body: {} },
    ];
    const error = await rejection(workbookBatch(requests, { retryNonIdempotent: false }));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestAt(2).url).toBe(`${GRAPH_BASE}${WORKBOOK_PREFIX}/closeSession`);
  });

  test('reports the first failing sub-response and the operations skipped after it', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(
      json(200, {
        responses: [
          { id: '1', status: 200 },
          { id: '2', status: 400, body: { error: { code: 'InvalidArgument', message: 'Bad width' } } },
          { id: '3', status: 424 },
        ],
      }),
    );
    const error = await rejection(
      workbookBatch(
        [
          { method: 'PATCH', path: '/a', body: {} },
          { method: 'PATCH', path: '/b', body: {} },
          { method: 'PATCH', path: '/c', body: {} },
        ],
        { retryNonIdempotent: true },
      ),
    );
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toContain('failed on "/b" (400): Bad width. 1 later operation(s) were skipped.');
  });
});

describe('probes', () => {
  test('issues exactly one request and records the raw status and request id', async () => {
    stubMirrorToken(fakeJwt('mirror'));
    fetchMock.mockResolvedValue(respond(500, { 'request-id': 'probe-1' }));
    const result = await settle(probeGraph('graph:/me', '/me', '/me', { $select: 'id' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAt(0).url).toBe(`${GRAPH_BASE}/me?%24select=id`);
    expect(requestAt(0).init.credentials).toBe('omit');
    expect(result).toMatchObject({
      name: 'graph:/me',
      path: '/me',
      status: 500,
      ok: false,
      requestId: 'probe-1',
      error: null,
    });
  });

  test('captures a network failure without throwing', async () => {
    stubMirrorToken(fakeJwt('mirror'));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await settle(probeGraph('graph:/me', '/me', '/me'));
    expect(result).toMatchObject({ status: null, ok: false, error: 'TypeError: Failed to fetch' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports a missing token as the probe error without a request', async () => {
    const result = await settle(probeGraph('graph:/me', '/me', '/me'));
    expect(result.status).toBeNull();
    expect(result.error).toContain('Not authenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('labels the /shares probe without the encoded share id', async () => {
    stubMirrorToken(fakeJwt('mirror'));
    fetchMock.mockResolvedValue(json(200, { id: 'item' }));
    const result = await settle(probeWorkbookShare(SHAREPOINT_URL));
    expect(requestAt(0).url).toMatch(/\/shares\/u!.+\/driveItem\?%24select=id$/);
    expect(result.path).toBe('/shares/{shareId}/driveItem');
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('u!');
    expect(JSON.stringify(result)).not.toContain('contoso');
  });
});

describe('locateWorkbook', () => {
  test('reads driveId/docId from the cloud app URL', () => {
    expect(locateWorkbook(new URL(CLOUD_APP_URL))).toEqual({ kind: 'url', driveId: 'drive-1', itemId: 'item-1' });
  });

  test('treats a SharePoint URL as a sharing URL', () => {
    expect(locateWorkbook(new URL(SHAREPOINT_URL))).toEqual({ kind: 'shares', sharingUrl: SHAREPOINT_URL });
  });

  test('is null for a page that is not a workbook', () => {
    expect(locateWorkbook(new URL('https://excel.cloud.microsoft/'))).toBeNull();
    expect(locateWorkbook(new URL('https://example.com/?driveId=only'))).toBeNull();
  });
});

describe('readReloadMarker', () => {
  test('prefers the marker the pre-script captured', () => {
    setPreScriptNamespace({ reloadMarker: { reason: 'SessionExpired', count: 2, subcode: 'x', capturedAt: 5 } });
    vi.mocked(getCurrentUrl).mockReturnValue(`${SHAREPOINT_URL}&wdrldr=Other`);
    expect(readReloadMarker()).toEqual({ reason: 'SessionExpired', count: 2, subcode: 'x', capturedAt: 5 });
  });

  test('falls back to the current URL when the pre-script did not run', () => {
    vi.mocked(getCurrentUrl).mockReturnValue(`${SHAREPOINT_URL}&wdrldr=Fallback&wdrldc=1`);
    expect(readReloadMarker()).toMatchObject({ reason: 'Fallback', count: 1, subcode: null });
  });

  test('is null when neither carries a marker', () => {
    expect(readReloadMarker()).toBeNull();
  });
});
