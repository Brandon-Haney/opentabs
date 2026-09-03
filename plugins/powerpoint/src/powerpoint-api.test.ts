/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://contoso.sharepoint.com/:p:/r/sites/x/deck.pptx?wdrldr=SessionExpired&wdrldc=1"}
 */
import { ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  api,
  describeActiveTokenSource,
  describeDriveIdSource,
  describeTokenSources,
  FILE_LOCKED_MESSAGE,
  fetchDownloadUrl,
  GRAPH_BASE,
  graphFetch,
  probeGraph,
  readReloadMarker,
  requireAuth,
} from './powerpoint-api.js';

const PAGE_PATH = '/:p:/r/sites/x/deck.pptx?wdrldr=SessionExpired&wdrldc=1';
const ITEM_ENDPOINT = '/drives/DRIVE-77/items/ITEM-SECRET-42';
const LS_TOKEN_KEY = '__opentabs_powerpoint_graph_token';
const MSAL_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';
const MSAL_TOKEN_KEY = `uid.utid-login.windows.net-accesstoken-${MSAL_CLIENT_ID}-tenant-https://graph.microsoft.com/files.readwrite.all openid`;
const FRONT_DOOR_REQUEST_STAGE = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';

const base64Url = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (claims: Record<string, unknown>): string =>
  `${base64Url('{"alg":"none"}')}.${base64Url(JSON.stringify(claims))}.sig`;

const nowSec = (): number => Math.floor(Date.now() / 1000);
const TOKEN = fakeJwt({ aud: 'https://graph.microsoft.com', upn: 'user@contoso.com' });

type OpenTabsGlobal = { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } };
type WopiGlobal = { _wopiContextJson?: { DriveId?: string; DriveItemId?: string } };

const setNamespace = (values: Record<string, unknown>): void => {
  (globalThis as OpenTabsGlobal).__openTabs = { preScript: { powerpoint: values } };
};
const clearNamespace = (): void => {
  delete (globalThis as OpenTabsGlobal).__openTabs;
};
const stubToken = (): void => setNamespace({ graph: { token: TOKEN, exp: nowSec() + 3600 } });

const respond = (
  status: number,
  headers?: Record<string, string>,
  body: BodyInit | null = `body-${status}`,
): Response => new Response(body, { status, headers });
const jsonResponse = (status: number, payload: unknown, headers?: Record<string, string>): Response =>
  respond(status, { 'content-type': 'application/json', ...headers }, JSON.stringify(payload));

/** Resolves `promise` while draining every pending timer so retry sleeps complete under fake timers. */
const settle = async <T>(promise: Promise<T>): Promise<T> => (await Promise.all([promise, vi.runAllTimersAsync()]))[0];

/** The `init` fetch received on call `index`. */
const initOf = (index: number): RequestInit => {
  const init = fetchMock.mock.calls[index]?.[1];
  if (init === undefined) throw new Error(`fetch call ${index} carried no init`);
  return init;
};
const urlOf = (index: number): string => String(fetchMock.mock.calls[index]?.[0]);
const headerOf = (index: number, name: string): string | undefined =>
  (initOf(index).headers as Record<string, string> | undefined)?.[name];

const rejection = async (promise: Promise<unknown>): Promise<ToolError> => {
  try {
    await settle(promise);
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw new Error(`expected a ToolError, got ${String(error)}`);
  }
  throw new Error('expected the promise to reject');
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  clearNamespace();
  delete (globalThis as WopiGlobal)._wopiContextJson;
  history.replaceState(null, '', PAGE_PATH);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('graphFetch — request shape', () => {
  test('sends a bearer-authenticated request without cookies to the Graph v1.0 base', async () => {
    stubToken();
    fetchMock.mockResolvedValueOnce(respond(200));
    await settle(graphFetch(ITEM_ENDPOINT, { query: { $select: 'id,eTag', skip: undefined } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(0)).toBe(`${GRAPH_BASE}${ITEM_ENDPOINT}?%24select=id%2CeTag`);
    expect(initOf(0).method).toBe('GET');
    expect(initOf(0).credentials).toBe('omit');
    expect(headerOf(0, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(initOf(0).signal).toBeInstanceOf(AbortSignal);
  });

  test('prefers a caller-resolved token and forwards body, content type and extra headers', async () => {
    stubToken();
    fetchMock.mockResolvedValueOnce(respond(200));
    const body = new Blob(['bytes']);
    await settle(
      graphFetch(`${ITEM_ENDPOINT}/content`, {
        method: 'put',
        body,
        contentType: 'application/x-test',
        headers: { 'If-Match': '"etag-1"' },
        token: 'caller-token',
      }),
    );
    expect(initOf(0).method).toBe('PUT');
    expect(initOf(0).body).toBe(body);
    expect(headerOf(0, 'Content-Type')).toBe('application/x-test');
    expect(headerOf(0, 'If-Match')).toBe('"etag-1"');
    expect(headerOf(0, 'Authorization')).toBe('Bearer caller-token');
  });

  test('throws AUTH_ERROR with the SharePoint reauth hint and sends nothing when no token is usable', async () => {
    const error = await rejection(graphFetch('/me'));
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain('Not authenticated');
    expect(error.message).toContain('powerpoint__reauthenticate');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('graphFetch — transient retries', () => {
  beforeEach(stubToken);

  test('retries a GET on 500 and resolves with the eventual 200, re-sending the same headers', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200));
    const response = await settle(graphFetch(ITEM_ENDPOINT));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headerOf(1, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(initOf(1).credentials).toBe('omit');
  });

  test('exhausted GET 500s become UPSTREAM_UNAVAILABLE naming the host, status, attempts and request-id — never the path', async () => {
    const failing = () =>
      jsonResponse(
        500,
        { error: { code: 'generalException', message: 'Something went wrong.' } },
        { 'request-id': 'req-500' },
      );
    fetchMock.mockResolvedValueOnce(failing()).mockResolvedValueOnce(failing()).mockResolvedValueOnce(failing());
    const error = await rejection(graphFetch(ITEM_ENDPOINT));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(5_000);
    expect(error.message).toContain('graph.microsoft.com returned HTTP 500');
    expect(error.message).toContain('generalException: Something went wrong.');
    expect(error.message).toContain('after 3 attempts');
    expect(error.message).toContain('request-id req-500');
    expect(error.message).not.toContain('ITEM-SECRET-42');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 3, requestId: 'req-500' });
  });

  test("names Microsoft's service front door when the last response carries its label", async () => {
    const frontDoor = () =>
      respond(500, {
        'x-proxyerrorlabel': 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpResponse',
        'x-proxyerrormessage': 'The network is busy.',
      });
    fetchMock.mockResolvedValueOnce(frontDoor()).mockResolvedValueOnce(frontDoor()).mockResolvedValueOnce(frontDoor());
    const error = await rejection(graphFetch(ITEM_ENDPOINT));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain("Microsoft's service front door failed the request to graph.microsoft.com");
    expect(error.message).toContain('"The network is busy."');
    expect(error.details).toEqual({
      httpStatus: 500,
      attempts: 3,
      frontDoorLabel: 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpResponse',
    });
  });

  test('does not replay a POST on 500 and reports a single attempt', async () => {
    fetchMock.mockResolvedValueOnce(respond(500));
    const error = await rejection(api(`${ITEM_ENDPOINT}/copy`, { method: 'POST', body: { name: 'x' } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('after 1 attempt.');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 1 });
  });

  test('replays a POST on 500 when the caller opts in with retryNonIdempotent', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(jsonResponse(200, { getUrl: 'https://p' }));
    const result = await settle(
      api<{ getUrl: string }>(`${ITEM_ENDPOINT}/preview`, { method: 'POST', body: {}, retryNonIdempotent: true }),
    );
    expect(result.getUrl).toBe('https://p');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(initOf(1).method).toBe('POST');
    expect(initOf(1).body).toBe('{}');
  });

  test('replays any method when the front door refused the request before forwarding it', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(502, { 'x-proxyerrorlabel': FRONT_DOOR_REQUEST_STAGE }))
      .mockResolvedValueOnce(respond(204, undefined, null));
    const result = await settle(api(`${ITEM_ENDPOINT}/permissions/p1`, { method: 'DELETE' }));
    expect(result).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a POST refused by the front door on every attempt reports the three attempts actually made', async () => {
    const refused = () =>
      respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_REQUEST_STAGE, 'x-proxyerrormessage': 'The network is busy.' });
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused());
    const error = await rejection(api(`${ITEM_ENDPOINT}/copy`, { method: 'POST', body: { name: 'x' } }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain("Microsoft's service front door failed the request to graph.microsoft.com");
    expect(error.message).toContain('after 3 attempts');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 3, frontDoorLabel: FRONT_DOOR_REQUEST_STAGE });
  });

  test('a plain 503 on a PUT without the opt-in reports the single attempt made', async () => {
    fetchMock.mockResolvedValueOnce(respond(503, { 'request-id': 'req-503' }));
    const error = await rejection(
      graphFetch(`${ITEM_ENDPOINT}/content`, { method: 'PUT', body: 'bytes', contentType: 'application/octet-stream' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('HTTP 503');
    expect(error.message).toContain('after 1 attempt;');
    expect(error.message).toContain('request-id req-503');
    expect(error.details).toEqual({ httpStatus: 503, attempts: 1, requestId: 'req-503' });
  });

  test('retries a GET through network TypeErrors and throws NETWORK_ERROR once exhausted', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(graphFetch(ITEM_ENDPOINT));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Network error reaching graph.microsoft.com after 3 attempts: Failed to fetch');
    expect(error.details).toEqual({ attempts: 3 });
  });

  test('throws NETWORK_ERROR after a single attempt for a POST that fails at the network layer', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await rejection(api(`${ITEM_ENDPOINT}/copy`, { method: 'POST', body: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe('Network error reaching graph.microsoft.com after 1 attempt: Failed to fetch');
    expect(error.details).toEqual({ attempts: 1 });
  });

  test('honors a short Retry-After on 429 and then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '1' })).mockResolvedValueOnce(respond(200));
    const startedAt = Date.now();
    const response = await settle(graphFetch(ITEM_ENDPOINT));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
  });

  test('returns a 429 with a long Retry-After as RATE_LIMITED after one attempt, carrying the delay', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '30', 'request-id': 'req-429' }));
    const error = await rejection(graphFetch(ITEM_ENDPOINT));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toContain('request-id req-429');
    expect(error.details).toEqual({ httpStatus: 429, requestId: 'req-429' });
  });

  test('does not retry 501 or 505 and classifies them as INTERNAL_ERROR', async () => {
    for (const status of [501, 505]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(respond(status));
      const error = await rejection(graphFetch(ITEM_ENDPOINT));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.message).toBe(`Microsoft Graph returned ${status} (Unexpected error): body-${status}`);
      expect(error.details).toEqual({ httpStatus: status });
    }
  });

  test('rethrows a TimeoutError as TIMEOUT naming the timeout, never the endpoint, without retrying', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const error = await rejection(graphFetch(ITEM_ENDPOINT, { timeoutMs: 5_000 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Microsoft Graph request timed out after 5000 ms');
    expect(error.message).not.toContain('ITEM-SECRET-42');
    expect(error.message).not.toContain('DRIVE-77');
    expect(error.details).toBeUndefined();
  });
});

describe('graphFetch — status classification', () => {
  beforeEach(stubToken);

  test('401 is AUTH_ERROR after one attempt, with the body, request-id and SharePoint reauth hint but no ids', async () => {
    fetchMock.mockResolvedValueOnce(respond(401, { 'x-ms-request-id': 'req-401' }));
    const error = await rejection(graphFetch(ITEM_ENDPOINT));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toBe(
      'Microsoft Graph returned 401 (Auth error): body-401 (request-id req-401) Call `powerpoint__reauthenticate` to recover.',
    );
    expect(error.message).not.toContain('ITEM-SECRET-42');
    expect(error.message).not.toContain('DRIVE-77');
    expect(error.details).toEqual({ httpStatus: 401, requestId: 'req-401' });
  });

  test('403 is AUTH_ERROR and 404 is NOT_FOUND, neither naming the endpoint', async () => {
    fetchMock.mockResolvedValueOnce(respond(403));
    const forbidden = await rejection(graphFetch(ITEM_ENDPOINT));
    expect(forbidden.code).toBe('AUTH_ERROR');
    expect(forbidden.message).toContain('Microsoft Graph returned 403 (Auth error)');
    expect(forbidden.message).not.toContain('ITEM-SECRET-42');
    expect(forbidden.message).not.toContain('DRIVE-77');
    expect(forbidden.details).toEqual({ httpStatus: 403 });

    fetchMock.mockResolvedValueOnce(respond(404, { 'request-id': 'req-404' }, null));
    const missing = await rejection(graphFetch(ITEM_ENDPOINT));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.message).toBe('Microsoft Graph returned 404 (Not found) (request-id req-404)');
    expect(missing.message).not.toContain('ITEM-SECRET-42');
    expect(missing.message).not.toContain('DRIVE-77');
    expect(missing.details).toEqual({ httpStatus: 404, requestId: 'req-404' });
  });

  test('400, 409 and 422 are VALIDATION_ERROR carrying the body but not the endpoint', async () => {
    for (const status of [400, 409, 422]) {
      fetchMock.mockResolvedValueOnce(respond(status));
      const error = await rejection(graphFetch(ITEM_ENDPOINT));
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe(`Microsoft Graph returned ${status} (Validation error): body-${status}`);
      expect(error.message).not.toContain('ITEM-SECRET-42');
      expect(error.message).not.toContain('DRIVE-77');
      expect(error.details).toEqual({ httpStatus: status });
    }
  });

  test('412 is VALIDATION_ERROR unless the caller owns the precondition', async () => {
    fetchMock.mockResolvedValueOnce(respond(412));
    const error = await rejection(graphFetch(`${ITEM_ENDPOINT}/content`, { method: 'PUT', body: 'x' }));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('Microsoft Graph returned 412 (Precondition failed');
    expect(error.message).not.toContain('ITEM-SECRET-42');
    expect(error.message).not.toContain('DRIVE-77');
    expect(error.details).toEqual({ httpStatus: 412 });

    fetchMock.mockResolvedValueOnce(respond(412));
    const response = await settle(
      graphFetch(`${ITEM_ENDPOINT}/content`, { method: 'PUT', body: 'x', allowPreconditionFailed: true }),
    );
    expect(response.status).toBe(412);
  });

  test('423 explains the co-authoring lock', async () => {
    fetchMock.mockResolvedValueOnce(respond(423));
    const error = await rejection(graphFetch(`${ITEM_ENDPOINT}/content`, { method: 'PUT', body: 'x' }));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe(FILE_LOCKED_MESSAGE);
    expect(error.details).toEqual({ httpStatus: 423 });
  });
});

describe('api', () => {
  beforeEach(stubToken);

  test('serializes a JSON body with its content type and parses the JSON reply', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'x' }));
    const result = await settle(api<{ id: string }>(ITEM_ENDPOINT, { method: 'PATCH', body: { name: 'renamed' } }));
    expect(result).toEqual({ id: 'x' });
    expect(initOf(0).method).toBe('PATCH');
    expect(initOf(0).body).toBe('{"name":"renamed"}');
    expect(headerOf(0, 'Content-Type')).toBe('application/json');
  });

  test('resolves with an empty object for 202 and 204 and sends no content type without a body', async () => {
    fetchMock.mockResolvedValueOnce(respond(204, undefined, null));
    expect(await settle(api(ITEM_ENDPOINT, { method: 'DELETE' }))).toEqual({});
    expect(headerOf(0, 'Content-Type')).toBeUndefined();
    fetchMock.mockResolvedValueOnce(respond(202, undefined, null));
    expect(await settle(api(`${ITEM_ENDPOINT}/copy`, { method: 'POST', body: {} }))).toEqual({});
  });
});

describe('requireAuth — drive resolution', () => {
  beforeEach(stubToken);

  test('resolves the drive through a retried /shares lookup on SharePoint and caches it for the URL', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'i', parentReference: { driveId: 'DRIVE-SHARES' } }));
    const auth = await settle(requireAuth());
    expect(auth).toEqual({ token: TOKEN, driveId: 'DRIVE-SHARES' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(0)).toContain(`${GRAPH_BASE}/shares/u!`);
    expect(urlOf(0)).toContain('%24select=id%2CparentReference');
    expect(describeDriveIdSource()).toBe('shares');

    fetchMock.mockClear();
    expect(await settle(requireAuth())).toEqual(auth);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reports an unresolvable drive after a single failed lookup', async () => {
    history.replaceState(null, '', '/:p:/r/sites/x/other.pptx');
    fetchMock.mockResolvedValueOnce(respond(404));
    const error = await rejection(requireAuth());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('Could not determine the current drive');
    expect(describeDriveIdSource()).toBeNull();
  });

  test('propagates an exhausted /shares outage as UPSTREAM_UNAVAILABLE instead of an unresolvable drive', async () => {
    history.replaceState(null, '', '/:p:/r/sites/x/outage.pptx');
    fetchMock.mockResolvedValue(respond(500, { 'request-id': 'req-shares' }));
    const error = await rejection(requireAuth());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('after 3 attempts');
    expect(error.message).toContain('request-id req-shares');
    expect(describeDriveIdSource()).toBeNull();
  });

  test('propagates a rejected token from the /shares lookup as AUTH_ERROR with the reauth hint', async () => {
    history.replaceState(null, '', '/:p:/r/sites/x/expired.pptx');
    fetchMock.mockResolvedValueOnce(respond(401));
    const error = await rejection(requireAuth());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain('powerpoint__reauthenticate');
    expect(describeDriveIdSource()).toBeNull();
  });

  test('uses an explicit drive id without any lookup', async () => {
    expect(await settle(requireAuth('DRIVE-EXPLICIT'))).toEqual({ token: TOKEN, driveId: 'DRIVE-EXPLICIT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('describeDriveIdSource', () => {
  test('is null when nothing on the page names a drive', () => {
    history.replaceState(null, '', '/:p:/r/sites/x/fresh.pptx');
    expect(describeDriveIdSource()).toBeNull();
  });

  test('reads the driveId query parameter first', () => {
    history.replaceState(null, '', '/:p:/r/sites/x/fresh.pptx?driveId=DRIVE-URL');
    expect(describeDriveIdSource()).toBe('url');
  });

  test('reads the WOPI context when the URL has no drive id', () => {
    history.replaceState(null, '', '/:p:/r/sites/x/fresh.pptx');
    (globalThis as WopiGlobal)._wopiContextJson = { DriveId: 'DRIVE-WOPI' };
    expect(describeDriveIdSource()).toBe('wopi');
  });

  test('derives the drive from the active MSAL account as a last synchronous resort', () => {
    history.replaceState(null, '', '/:p:/r/sites/x/fresh.pptx');
    localStorage.setItem(`msal.${MSAL_CLIENT_ID}.active-account`, '00000000-0000-0000-abcd-0123456789ab.tenant');
    expect(describeDriveIdSource()).toBe('msalAccount');
  });
});

describe('describeTokenSources / describeActiveTokenSource', () => {
  test('reports every source absent when no token exists anywhere', () => {
    expect(describeTokenSources()).toEqual([
      { source: 'preScript', present: false, expiresInSec: null, audience: null, fingerprint: null },
      { source: 'localStorageMirror', present: false, expiresInSec: null, audience: null, fingerprint: null },
      { source: 'msalPlaintext', present: false, expiresInSec: null, audience: null, fingerprint: null },
    ]);
    expect(describeActiveTokenSource()).toBeNull();
  });

  test('describes presence, expiry, audience host and a shared fingerprint without exposing the token', () => {
    const exp = nowSec() + 3600;
    setNamespace({ graph: { token: TOKEN, exp } });
    localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token: TOKEN, exp }));
    localStorage.setItem(MSAL_TOKEN_KEY, JSON.stringify({ secret: TOKEN, expiresOn: String(exp) }));

    const sources = describeTokenSources();
    expect(sources.map(s => s.source)).toEqual(['preScript', 'localStorageMirror', 'msalPlaintext']);
    for (const status of sources) {
      expect(status.present).toBe(true);
      expect(status.expiresInSec).toBeGreaterThan(3500);
      expect(status.expiresInSec).toBeLessThanOrEqual(3600);
      expect(status.audience).toBe('graph.microsoft.com');
      expect(status.fingerprint).toMatch(/^[0-9a-f]{4}$/);
    }
    expect(new Set(sources.map(s => s.fingerprint)).size).toBe(1);
    expect(JSON.stringify(sources)).not.toContain(TOKEN);
    expect(JSON.stringify(sources)).not.toContain(TOKEN.split('.')[1]);
    expect(describeActiveTokenSource()).toBe('preScript');
  });

  test('skips an expired source when choosing the active one and reports its negative expiry', () => {
    setNamespace({ graph: { token: TOKEN, exp: nowSec() - 60 } });
    localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token: TOKEN, exp: nowSec() + 600 }));
    const [preScript] = describeTokenSources();
    expect(preScript).toMatchObject({ present: true });
    expect(preScript?.expiresInSec).toBeLessThan(0);
    expect(describeActiveTokenSource()).toBe('localStorageMirror');
  });

  test('reports a non-URL audience verbatim and distinguishes different tokens by fingerprint', () => {
    const other = fakeJwt({ aud: '00000003-0000-0000-c000-000000000000' });
    setNamespace({ graph: { token: TOKEN, exp: nowSec() + 600 } });
    localStorage.setItem(MSAL_TOKEN_KEY, JSON.stringify({ secret: other, expiresOn: String(nowSec() + 600) }));
    const [preScript, , msal] = describeTokenSources();
    expect(msal?.audience).toBe('00000003-0000-0000-c000-000000000000');
    expect(msal?.fingerprint).not.toBe(preScript?.fingerprint);
  });

  test('treats a malformed mirror entry as absent', () => {
    localStorage.setItem(LS_TOKEN_KEY, '{not json');
    expect(describeTokenSources()[1]?.present).toBe(false);
  });
});

describe('probeGraph', () => {
  test('sends exactly one bearer-authenticated request and records the raw response', async () => {
    stubToken();
    fetchMock.mockResolvedValueOnce(respond(500, { 'request-id': 'req-probe' }));
    const result = await settle(probeGraph('graph:/me', '/me', '/me', { $select: 'id' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(0)).toBe(`${GRAPH_BASE}/me?%24select=id`);
    expect(initOf(0).credentials).toBe('omit');
    expect(headerOf(0, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(result).toMatchObject({
      name: 'graph:/me',
      path: '/me',
      status: 500,
      ok: false,
      requestId: 'req-probe',
      frontDoor: null,
      error: null,
    });
  });

  test('records the label, never the endpoint, and captures a network failure', async () => {
    stubToken();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await settle(
      probeGraph('graph:/shares', '/shares/{shareId}/driveItem', '/shares/u!SECRET/driveItem'),
    );
    expect(result.path).toBe('/shares/{shareId}/driveItem');
    expect(JSON.stringify(result)).not.toContain('u!SECRET');
    expect(result).toMatchObject({ status: null, ok: false, error: 'TypeError: Failed to fetch' });
  });

  test('records the auth error without sending anything when no token is usable', async () => {
    const result = await settle(probeGraph('graph:/me', '/me', '/me'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBeNull();
    expect(result.error).toContain('ToolError: Not authenticated');
  });
});

describe('fetchDownloadUrl', () => {
  const DOWNLOAD_URL =
    'https://contoso-my.sharepoint.com/personal/x/_layouts/15/download.aspx?tempauth=SECRET-TEMPAUTH';

  test('sends no bearer header and no cookies, and retries a transient status', async () => {
    stubToken();
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(200, undefined, 'PK'));
    const response = await settle(fetchDownloadUrl(DOWNLOAD_URL, { timeoutMs: 60_000 }));
    expect(await response.text()).toBe('PK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(0)).toBe(DOWNLOAD_URL);
    expect(initOf(0).credentials).toBe('omit');
    expect(initOf(0).headers).toBeUndefined();
  });

  test('classifies a non-transient failure as INTERNAL_ERROR naming only the host', async () => {
    fetchMock.mockResolvedValueOnce(respond(403, { 'request-id': 'req-dl' }));
    const error = await rejection(fetchDownloadUrl(DOWNLOAD_URL));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toContain('contoso-my.sharepoint.com (403)');
    expect(error.message).toContain('request-id req-dl');
    expect(error.message).not.toContain('SECRET-TEMPAUTH');
    expect(error.details).toEqual({ httpStatus: 403, requestId: 'req-dl' });
  });

  test('classifies exhausted transient failures as UPSTREAM_UNAVAILABLE naming only the host', async () => {
    fetchMock.mockResolvedValue(respond(502));
    const error = await rejection(fetchDownloadUrl(DOWNLOAD_URL));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('contoso-my.sharepoint.com returned HTTP 502');
    expect(error.message).not.toContain('SECRET-TEMPAUTH');
    expect(error.details).toEqual({ httpStatus: 502, attempts: 3 });
  });
});

describe('readReloadMarker', () => {
  test('prefers the marker the pre-script captured', () => {
    setNamespace({ reloadMarker: { reason: 'Captured', count: 3, subcode: 'sc', capturedAt: 1 } });
    expect(readReloadMarker()).toEqual({ reason: 'Captured', count: 3, subcode: 'sc', capturedAt: 1 });
  });

  test('falls back to the marker still on the current URL', () => {
    expect(readReloadMarker()).toMatchObject({ reason: 'SessionExpired', count: 1, subcode: null });
  });

  test('is null when neither the pre-script nor the URL carries a marker', () => {
    history.replaceState(null, '', '/:p:/r/sites/x/deck.pptx');
    expect(readReloadMarker()).toBeNull();
  });
});
