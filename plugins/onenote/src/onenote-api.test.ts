/**
 * @vitest-environment jsdom
 */
import { ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, describeTokenSources, GRAPH_BASE, isAuthenticated, probeGraph } from './onenote-api.js';
import {
  clearTokenSources,
  installMirrorToken,
  installMsalToken,
  installPreScriptToken,
  makeGraphToken,
  nowSec,
} from './test-support/tokens.js';

/** The page URL the SDK's getCurrentUrl reports; jsdom cannot change origin, so the SDK export is replaced. */
const page = vi.hoisted(() => ({ url: 'https://onenote.cloud.microsoft/' }));

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  getCurrentUrl: () => page.url,
}));

const CLOUD_APP_URL = 'https://onenote.cloud.microsoft/';
const SHAREPOINT_URL =
  'https://contoso.sharepoint.com/sites/eng/_layouts/15/Doc.aspx?sourcedoc=%7B1234%7D&wd=target(Notes.one%7Cabc%2F)';
const HOST = 'graph.microsoft.com';
const NOTES_TOKEN = makeGraphToken({ scp: 'Notes.ReadWrite User.Read', aud: 'https://graph.microsoft.com' });
const FILES_TOKEN = makeGraphToken({ scp: 'Files.ReadWrite.All Sites.Read.All', aud: 'https://graph.microsoft.com' });
const FRONT_DOOR_REFUSAL = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';

const respond = (status: number, headers?: Record<string, string>, body: BodyInit | null = null): Response =>
  new Response(body, { status, headers });

const jsonResponse = (status: number, payload: unknown, headers?: Record<string, string>): Response =>
  respond(status, { 'content-type': 'application/json; odata.metadata=minimal', ...headers }, JSON.stringify(payload));

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Attaches handlers before draining the fake timers, so a rejection during a retry sleep is never unhandled. */
const settled = async <T>(promise: Promise<T>): Promise<Outcome<T>> => {
  const outcome = promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
};

const resolved = async <T>(promise: Promise<T>): Promise<T> => {
  const outcome = await settled(promise);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

const failure = async (promise: Promise<unknown>): Promise<ToolError> => {
  const outcome = await settled(promise);
  if (outcome.ok) throw new Error('expected the request to reject');
  expect(outcome.error).toBeInstanceOf(ToolError);
  return outcome.error as ToolError;
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const requestAt = (index: number): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch was called ${fetchMock.mock.calls.length} times; no call at index ${index}`);
  const [input, init] = call;
  if (typeof input !== 'string' || init === undefined) throw new Error('expected fetch(url: string, init)');
  return { url: input, init };
};

const headersOf = (init: RequestInit): Record<string, string> => {
  const headers = init.headers;
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
    throw new Error('expected a plain headers record');
  }
  return headers;
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  page.url = CLOUD_APP_URL;
  clearTokenSources();
});

afterEach(() => {
  clearTokenSources();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('api — authentication', () => {
  test('throws AUTH_ERROR without a token on the standalone app and never fetches', async () => {
    const error = await failure(api('/me'));
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain('log in to Microsoft OneNote');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('explains the missing Notes scope on a SharePoint-hosted notebook and never fetches', async () => {
    page.url = SHAREPOINT_URL;
    installPreScriptToken(FILES_TOKEN, nowSec() + 3600);
    const error = await failure(api('/me/onenote/notebooks'));
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain('no OneNote (Notes) scope');
    expect(error.message).toContain('read_current_page');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends the selected token as a bearer header with credentials omitted and a timeout signal', async () => {
    installMsalToken(NOTES_TOKEN);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'me' }));
    await expect(resolved(api<{ id: string }>('/me'))).resolves.toEqual({ id: 'me' });
    const { url, init } = requestAt(0);
    expect(url).toBe(`${GRAPH_BASE}/me`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(headersOf(init)).toEqual({ Authorization: `Bearer ${NOTES_TOKEN}` });
  });
});

describe('api — request encoding', () => {
  beforeEach(() => {
    installMsalToken(NOTES_TOKEN);
  });

  test('appends the query string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { value: [] }));
    await resolved(api('/me/onenote/notebooks', { query: { $top: 5, $select: 'id', $skip: undefined } }));
    const params = new URL(requestAt(0).url).searchParams;
    expect(params.get('$top')).toBe('5');
    expect(params.get('$select')).toBe('id');
    expect(params.has('$skip')).toBe(false);
  });

  test('serializes an object body as JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'nb' }));
    await resolved(api('/me/onenote/notebooks', { method: 'POST', body: { displayName: 'Plans' } }));
    const { init } = requestAt(0);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"displayName":"Plans"}');
    expect(headersOf(init)['Content-Type']).toBe('application/json');
  });

  test('sends a string body verbatim as text/html by default, or as the given contentType', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'p1' })).mockResolvedValueOnce(jsonResponse(201, {}));
    await resolved(api('/me/onenote/sections/s1/pages', { method: 'POST', body: '<html><title>T</title></html>' }));
    await resolved(api('/me/onenote/sections/s1/pages', { method: 'POST', body: 'a=b', contentType: 'text/plain' }));
    expect(requestAt(0).init.body).toBe('<html><title>T</title></html>');
    expect(headersOf(requestAt(0).init)['Content-Type']).toBe('text/html');
    expect(headersOf(requestAt(1).init)['Content-Type']).toBe('text/plain');
  });

  test('returns an empty object for 204', async () => {
    fetchMock.mockResolvedValueOnce(respond(204));
    await expect(resolved(api('/me/onenote/notebooks/nb1'))).resolves.toEqual({});
  });
});

describe('api — status classification', () => {
  const NOTEBOOK_ID = '1-a1b2c3d4!123-77';
  const SECTION_ID = '1-e5f6a7b8!456-88';
  const graphError = (status: number, code: string, message: string, headers?: Record<string, string>): Response =>
    jsonResponse(status, { error: { code, message } }, headers);

  beforeEach(() => {
    installMsalToken(NOTES_TOKEN);
  });

  test.each([
    [401, 'AUTH_ERROR', 'Auth error (401)'],
    [403, 'AUTH_ERROR', 'Auth error (403)'],
    [404, 'NOT_FOUND', 'Not found: /me/onenote/notebooks/{id}/sections'],
    [400, 'VALIDATION_ERROR', 'Validation error: /me/onenote/notebooks/{id}/sections'],
    [422, 'VALIDATION_ERROR', 'Validation error: /me/onenote/notebooks/{id}/sections'],
    [501, 'INTERNAL_ERROR', 'API error (501): /me/onenote/notebooks/{id}/sections'],
  ])('maps %i to %s after a single attempt, naming the envelope and request id but never the id', async (status, code, prefix) => {
    fetchMock.mockResolvedValueOnce(
      graphError(status, `Code${status}`, `Message ${status}`, { 'request-id': 'req-4xx' }),
    );
    const error = await failure(api(`/me/onenote/notebooks/${NOTEBOOK_ID}/sections`));
    expect(error.code).toBe(code);
    expect(error.message).toBe(`${prefix} — Code${status}: Message ${status} (request-id req-4xx)`);
    expect(error.message).not.toContain(NOTEBOOK_ID);
    expect(error.details).toEqual({ httpStatus: status, requestId: 'req-4xx' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('redacts every id-bearing segment while keeping the getRecentNotebooks function segment', async () => {
    fetchMock
      .mockResolvedValueOnce(graphError(404, 'ItemNotFound', 'Gone'))
      .mockResolvedValueOnce(graphError(404, 'ItemNotFound', 'Gone'))
      .mockResolvedValueOnce(graphError(404, 'ItemNotFound', 'Gone'));
    const pages = await failure(api(`/me/onenote/sections/${SECTION_ID}/pages`));
    const group = await failure(api(`/me/onenote/sectionGroups/${NOTEBOOK_ID}`));
    const recent = await failure(api('/me/onenote/notebooks/getRecentNotebooks(includePersonalNotebooks=true)'));
    expect(pages.message).toBe('Not found: /me/onenote/sections/{id}/pages — ItemNotFound: Gone');
    expect(group.message).toBe('Not found: /me/onenote/sectionGroups/{id} — ItemNotFound: Gone');
    expect(recent.message).toBe(
      'Not found: /me/onenote/notebooks/getRecentNotebooks(includePersonalNotebooks=true) — ItemNotFound: Gone',
    );
    for (const error of [pages, group, recent]) {
      expect(error.message).not.toContain(SECTION_ID);
      expect(error.message).not.toContain(NOTEBOOK_ID);
    }
  });

  test('never quotes a non-JSON body and omits the request id when the response carries none', async () => {
    fetchMock.mockResolvedValueOnce(respond(404, { 'content-type': 'text/html' }, `<html>${NOTEBOOK_ID}</html>`));
    const error = await failure(api(`/me/onenote/notebooks/${NOTEBOOK_ID}`));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Not found: /me/onenote/notebooks/{id}');
    expect(error.details).toEqual({ httpStatus: 404 });
  });

  test('truncates a long envelope message', async () => {
    fetchMock.mockResolvedValueOnce(graphError(400, 'InvalidRequest', 'x'.repeat(300)));
    const error = await failure(api('/me/onenote/notebooks'));
    expect(error.message).toBe(`Validation error: /me/onenote/notebooks — InvalidRequest: ${'x'.repeat(199)}…`);
  });

  test('keeps 429 as RATE_LIMITED with the Retry-After delay once retries are exhausted', async () => {
    fetchMock.mockImplementation(async () =>
      graphError(429, 'TooManyRequests', 'Slow down', { 'Retry-After': '2', 'request-id': 'req-429' }),
    );
    const error = await failure(api(`/me/onenote/notebooks/${NOTEBOOK_ID}`));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(2000);
    expect(error.message).toBe(
      'Rate limited: /me/onenote/notebooks/{id} — TooManyRequests: Slow down (request-id req-429)',
    );
    expect(error.message).not.toContain(NOTEBOOK_ID);
    expect(error.details).toEqual({ httpStatus: 429, requestId: 'req-429' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('api — transient retries', () => {
  beforeEach(() => {
    installMsalToken(NOTES_TOKEN);
  });

  test('retries a GET through a 500 and resolves with the eventual body', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(jsonResponse(200, { value: [1] }));
    await expect(resolved(api('/me/onenote/notebooks'))).resolves.toEqual({ value: [1] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('throws UPSTREAM_UNAVAILABLE naming the host, status, attempts and request id after a GET exhausts retries', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        503,
        { error: { code: 'ServiceUnavailable', message: 'Try again' } },
        { 'request-id': 'req-77', 'Retry-After': '1' },
      ),
    );
    const error = await failure(api('/me/onenote/notebooks/nb1/sections'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1000);
    expect(error.message).toBe(
      `${HOST} returned HTTP 503 (ServiceUnavailable: Try again) after 3 attempts; request-id req-77.`,
    );
    expect(error.message).not.toContain('nb1');
    expect(error.details).toEqual({ httpStatus: 503, attempts: 3, requestId: 'req-77' });
  });

  test('does not replay a POST create on 500 and hints that the item may exist', async () => {
    fetchMock.mockResolvedValueOnce(respond(500, { 'request-id': 'req-1' }));
    const error = await failure(
      api('/me/onenote/sections/s1/pages', { method: 'POST', body: '<html><title>T</title></html>' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain(`${HOST} returned HTTP 500 after 1 attempt; request-id req-1.`);
    expect(error.message).toContain('was not retried because a replay could duplicate the item');
    expect(error.message).not.toContain('s1');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 1, requestId: 'req-1' });
  });

  test('replays a POST the service front door refused before forwarding, without the duplicate hint', async () => {
    fetchMock.mockImplementation(async () =>
      respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL, 'x-proxyerrormessage': 'The network is busy.' }),
    );
    const error = await failure(api('/me/onenote/notebooks', { method: 'POST', body: { displayName: 'X' } }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toBe(
      `Microsoft's service front door failed the request to ${HOST} with HTTP 500 "The network is busy." after 3 attempts.`,
    );
    expect(error.message).not.toContain('not retried');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 3, frontDoorLabel: FRONT_DOOR_REFUSAL });
  });

  test('reports one attempt and no duplicate hint when a GET 503 carries a Retry-After above the wait cap', async () => {
    fetchMock.mockResolvedValueOnce(respond(503, { 'Retry-After': '30' }));
    const error = await failure(api('/me/onenote/notebooks'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toBe(`${HOST} returned HTTP 503 after 1 attempt.`);
    expect(error.details).toEqual({ httpStatus: 503, attempts: 1 });
  });

  test('reports "after 1 attempt" with the duplicate hint for a plain 503 on a POST create', async () => {
    fetchMock.mockResolvedValueOnce(respond(503, { 'Retry-After': '1', 'request-id': 'req-503' }));
    const error = await failure(api('/me/onenote/notebooks', { method: 'POST', body: { displayName: 'X' } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryAfterMs).toBe(1000);
    expect(error.message).toContain(`${HOST} returned HTTP 503 after 1 attempt; request-id req-503.`);
    expect(error.message).toContain('was not retried because a replay could duplicate the item');
    expect(error.details).toEqual({ httpStatus: 503, attempts: 1, requestId: 'req-503' });
  });

  test('reports the observed count when a front-door refusal precedes a plain 503 on a POST create', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL }))
      .mockResolvedValueOnce(respond(503, { 'request-id': 'req-2' }));
    const error = await failure(api('/me/onenote/notebooks', { method: 'POST', body: { displayName: 'X' } }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain(`${HOST} returned HTTP 503 after 2 attempts; request-id req-2.`);
    expect(error.message).toContain('was not retried because a replay could duplicate the item');
    expect(error.details).toEqual({ httpStatus: 503, attempts: 2, requestId: 'req-2' });
  });

  test('classifies a front-door refusal as UPSTREAM_UNAVAILABLE even on a non-transient status', async () => {
    fetchMock.mockImplementation(async () =>
      respond(404, { 'x-proxyerrorlabel': FRONT_DOOR_REFUSAL, 'x-proxyerrormessage': 'No route.' }),
    );
    const error = await failure(api('/me/onenote/notebooks/nb1'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(
      `Microsoft's service front door failed the request to ${HOST} with HTTP 404 "No route." after 3 attempts.`,
    );
    expect(error.message).not.toContain('nb1');
  });

  test('throws NETWORK_ERROR after a GET exhausts retries on network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await failure(api('/me/onenote/notebooks'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(`Network error reaching ${HOST} after 3 attempts: Failed to fetch`);
    expect(error.details).toEqual({ attempts: 3 });
  });

  test('throws NETWORK_ERROR after a single attempt when a POST fails on the network', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await failure(api('/me/onenote/notebooks', { method: 'POST', body: { displayName: 'X' } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe(`Network error reaching ${HOST} after 1 attempt: Failed to fetch`);
    expect(error.details).toEqual({ attempts: 1 });
  });

  test('maps the request timeout to TIMEOUT without retrying, naming the redacted endpoint', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    const error = await failure(api('/me/onenote/sections/1-e5f6a7b8!456-88/pages'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toBe('API request timed out: /me/onenote/sections/{id}/pages');
    expect(error.message).not.toContain('1-e5f6a7b8!456-88');
    expect(error.details).toBeUndefined();
  });
});

describe('describeTokenSources', () => {
  test('reports every source absent and no active source when nothing is stored', () => {
    const report = describeTokenSources();
    expect(report.activeSource).toBeNull();
    expect(report.sources.map(s => s.source)).toEqual(['preScriptNamespace', 'localStorageMirror', 'msalPlaintext']);
    for (const source of report.sources) {
      expect(source).toEqual({
        source: source.source,
        present: false,
        expiresInSec: null,
        audience: null,
        fingerprint: null,
        scopes: [],
        notesScope: false,
      });
    }
    expect(isAuthenticated()).toBe(false);
  });

  test('skips a captured token without a Notes scope and activates the MSAL token, never exposing either', () => {
    installPreScriptToken(FILES_TOKEN, nowSec() + 3600);
    installMsalToken(NOTES_TOKEN, nowSec() + 7200);
    const report = describeTokenSources();
    const [namespace, mirror, msal] = report.sources;
    expect(namespace).toMatchObject({
      source: 'preScriptNamespace',
      present: true,
      audience: HOST,
      scopes: ['Files.ReadWrite.All', 'Sites.Read.All'],
      notesScope: false,
    });
    expect(namespace?.expiresInSec).toBeGreaterThan(3500);
    expect(namespace?.fingerprint).toMatch(/^[0-9a-f]{4}$/);
    expect(mirror?.present).toBe(false);
    expect(msal).toMatchObject({
      source: 'msalPlaintext',
      present: true,
      notesScope: true,
      scopes: ['Notes.ReadWrite', 'User.Read'],
    });
    expect(msal?.expiresInSec).toBeGreaterThan(7100);
    expect(msal?.fingerprint).not.toBe(namespace?.fingerprint);
    expect(report.activeSource).toBe('msalPlaintext');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(FILES_TOKEN);
    expect(serialized).not.toContain(NOTES_TOKEN);
  });

  test('activates a Notes-scoped pre-script capture ahead of the MSAL cache and uses it for requests', async () => {
    const otherNotesToken = makeGraphToken({ scp: 'Notes.Create', aud: '00000003-0000-0000-c000-000000000000' });
    installPreScriptToken(NOTES_TOKEN, nowSec() + 3600);
    installMsalToken(otherNotesToken);
    expect(describeTokenSources().activeSource).toBe('preScriptNamespace');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await resolved(api('/me'));
    expect(headersOf(requestAt(0).init).Authorization).toBe(`Bearer ${NOTES_TOKEN}`);
  });

  test('reads the localStorage mirror when the in-page namespace is empty', () => {
    installMirrorToken(NOTES_TOKEN, nowSec() + 3600);
    const report = describeTokenSources();
    expect(report.sources[1]).toMatchObject({ source: 'localStorageMirror', present: true, notesScope: true });
    expect(report.activeSource).toBe('localStorageMirror');
  });

  test('reports a capture inside its expiry margin as present but not active', () => {
    installPreScriptToken(NOTES_TOKEN, nowSec() + 10);
    const report = describeTokenSources();
    expect(report.sources[0]?.present).toBe(true);
    expect(report.sources[0]?.expiresInSec).toBeLessThanOrEqual(10);
    expect(report.activeSource).toBeNull();
  });

  test('reports an expired MSAL entry with a negative expiry and treats an entry without expiresOn as live', () => {
    installMsalToken(NOTES_TOKEN, nowSec() - 60);
    const expired = describeTokenSources();
    expect(expired.sources[2]?.present).toBe(true);
    expect(expired.sources[2]?.expiresInSec).toBeLessThan(0);
    expect(expired.activeSource).toBeNull();

    installMsalToken(NOTES_TOKEN);
    const live = describeTokenSources();
    expect(live.sources[2]?.expiresInSec).toBeNull();
    expect(live.activeSource).toBe('msalPlaintext');
  });

  test('reports a non-URL audience claim verbatim', () => {
    installMsalToken(makeGraphToken({ scp: 'Notes.Read', aud: '00000003-0000-0000-c000-000000000000' }));
    expect(describeTokenSources().sources[2]?.audience).toBe('00000003-0000-0000-c000-000000000000');
  });

  test('reads the clock once so liveness and expiresInSec are judged at the same instant', () => {
    installPreScriptToken(NOTES_TOKEN, nowSec() + 3600);
    installMsalToken(NOTES_TOKEN, nowSec() + 7200);
    const clock = vi.spyOn(Date, 'now');
    describeTokenSources();
    expect(clock).toHaveBeenCalledTimes(1);
  });
});

describe('probeGraph', () => {
  test('records a skipped probe without a request when no Notes-scoped token exists', async () => {
    installPreScriptToken(FILES_TOKEN, nowSec() + 3600);
    const result = await probeGraph('graph:/me/onenote/notebooks', '/me/onenote/notebooks', { $top: 1 });
    expect(result).toEqual({
      name: 'graph:/me/onenote/notebooks',
      path: '/me/onenote/notebooks',
      status: null,
      ok: false,
      latencyMs: 0,
      requestId: null,
      frontDoor: null,
      error: 'no Notes-scoped token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('issues exactly one bearer GET and reports the raw status even when it fails', async () => {
    installMsalToken(NOTES_TOKEN);
    fetchMock.mockImplementation(async () => respond(500, { 'request-id': 'req-9' }));
    const result = await resolved(probeGraph('graph:/me/onenote/notebooks', '/me/onenote/notebooks', { $top: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = requestAt(0);
    expect(url).toBe(`${GRAPH_BASE}/me/onenote/notebooks?%24top=1`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(headersOf(init)).toEqual({ Authorization: `Bearer ${NOTES_TOKEN}` });
    expect(result).toMatchObject({
      path: '/me/onenote/notebooks',
      status: 500,
      ok: false,
      requestId: 'req-9',
      error: null,
    });
  });
});
