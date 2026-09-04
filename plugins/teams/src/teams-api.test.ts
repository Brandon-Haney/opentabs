import { ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest';
import type { ProbeResult } from './diagnostics.js';
import {
  buildMessageSearchBody,
  chatApi,
  clearCaches,
  createThread,
  describeTokenSources,
  getSkypeIdentity,
  probeAuthz,
  probeChatService,
  probeSubstrate,
  substrateSearch,
  TEAMS_TOKEN_SOURCES,
  threadApi,
} from './teams-api.js';

// Without a `window`, teams-api detects enterprise Teams and falls back to the fixed AMER endpoints.
const AUTHZ_URL = 'https://teams.microsoft.com/api/authsvc/v1.0/authz';
const CHAT_BASE = 'https://teams.microsoft.com/api/chatsvc/amer';
const SUBSTRATE_URL = 'https://substrate.office.com/searchservice/api/v2/query';
const CONVERSATION_ID = '19:secret-thread@thread.v2';
const MESSAGES_ENDPOINT = `/v1/users/ME/conversations/${encodeURIComponent(CONVERSATION_ID)}/messages`;
const REQUEST_STAGE_LABEL = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';

const base64url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A structurally valid, unsigned JWT carrying `claims`; the signature segment doubles as a unique marker. */
const jwt = (claims: Record<string, unknown>, marker: string): string =>
  `${base64url(JSON.stringify({ alg: 'none' }))}.${base64url(JSON.stringify(claims))}.${marker}`;

const nowSec = (): number => Math.floor(Date.now() / 1000);

const MSAL_SKYPE_TOKEN = jwt({ aud: 'https://api.spaces.skype.com', exp: 0 }, 'msal-skype-secret');
const LOKI_TOKEN = jwt({ aud: '394866fc-eedb-4f01-8536-3ff84b16be2a' }, 'loki-secret');
const SKYPE_JWT = jwt({ skypeid: 'live:.cid.abc123' }, 'skype-jwt-secret');
const SUBSTRATE_TOKEN = jwt(
  { aud: 'https://substrate.office.com', tid: 'tenant-1', puid: 'puid-1', oid: 'oid-1' },
  'substrate-secret',
);
const SIGN_IN_NAME = 'someone@contoso.com';

type PreScriptSlots = Record<string, unknown>;

/** Installs the pre-script namespace the adapter reads its captured credentials from. */
const stubPreScript = (slots: PreScriptSlots): void => {
  vi.stubGlobal('__openTabs', { preScript: { teams: slots } });
};

const capturedToken = (secret: string, ttlSec = 3600): { secret: string; expiresOn: number } => ({
  secret,
  expiresOn: nowSec() + ttlSec,
});

/** Teams v2 shape: the Skype JWT arrives from the authsvc interceptor, so no exchange is needed. */
const withPreCapturedJwt = (extra: PreScriptSlots = {}): void =>
  stubPreScript({ skypeJwt: capturedToken(SKYPE_JWT), ...extra });

/** Classic Teams shape: only the MSAL token is captured, so the adapter exchanges it at authsvc. */
const withMsalTokenOnly = (): void => stubPreScript({ enterpriseToken: capturedToken(MSAL_SKYPE_TOKEN) });

const respond = (
  status: number,
  headers?: Record<string, string>,
  body: BodyInit | null = `body-${status}`,
): Response => new Response(body, { status, headers });

const json = (payload: unknown, status = 200, headers?: Record<string, string>): Response =>
  respond(status, { 'content-type': 'application/json', ...headers }, JSON.stringify(payload));

const authzOk = (): Response => json({ tokens: { skypeToken: SKYPE_JWT, expiresIn: 3600 } });

const networkFailure = (): TypeError => new TypeError('Failed to fetch');

/** Resolves `promise` while draining every pending timer so retry sleeps complete under fake timers. */
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  await vi.runAllTimersAsync();
  return promise;
};

/** Rejection of `promise` as a ToolError, with the timers drained. */
const settleError = async (promise: Promise<unknown>): Promise<ToolError> => {
  const outcome = await settle(
    promise.then(
      () => undefined,
      (error: unknown) => error,
    ),
  );
  expect(outcome).toBeInstanceOf(ToolError);
  return outcome as ToolError;
};

/** The authsvc probe outcome on Teams v2, where no MSAL token is captured and the exchange makes no request. */
const authsvcSkipped = (): ProbeResult => ({
  name: 'authsvc',
  path: '/api/authsvc/v1.0/authz',
  status: null,
  ok: false,
  latencyMs: 0,
  requestId: null,
  frontDoor: null,
  error: 'ToolError: Not authenticated — no Skype API access token captured for enterprise Teams.',
});

const requestUrl = (call: number): string => String(fetchMock.mock.calls[call]?.[0]);
const requestInit = (call: number): RequestInit => fetchMock.mock.calls[call]?.[1] ?? {};
const requestHeaders = (call: number): Record<string, string> => requestInit(call).headers as Record<string, string>;

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

/**
 * Observes the SDK's retry warning. Outside the adapter runtime the SDK log
 * falls through to the console, so a console spy is the only place where the
 * data fetchWithRetry logs for a Teams request can be inspected.
 */
let consoleWarn: MockInstance<Console['warn']>;

beforeEach(() => {
  vi.useFakeTimers();
  // A whole-second clock keeps the second-granularity expiry arithmetic exact.
  vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearCaches();
});

afterEach(() => {
  clearCaches();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('chatApi', () => {
  test('sends the Skype token header with cookies to the chat service', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(json({ messages: [] }));

    await settle(chatApi(MESSAGES_ENDPOINT, { query: { pageSize: 5, skip: undefined } }));

    expect(requestUrl(0)).toBe(`${CHAT_BASE}${MESSAGES_ENDPOINT}?pageSize=5`);
    expect(requestInit(0).method).toBe('GET');
    expect(requestInit(0).credentials).toBe('include');
    expect(requestHeaders(0).Authentication).toBe(`skypetoken=${SKYPE_JWT}`);
  });

  test('retries a GET on 500 and resolves with the eventual body', async () => {
    withPreCapturedJwt();
    fetchMock
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(json({ messages: [{ id: '1' }] }));

    const data = await settle(chatApi<{ messages: unknown[] }>(MESSAGES_ENDPOINT));

    expect(data.messages).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    const [warnMessage, warnData] = consoleWarn.mock.calls[0] ?? [];
    expect(warnMessage).toContain('transient upstream failure, retrying');
    expect(warnData).toMatchObject({
      host: 'teams.microsoft.com',
      method: 'GET',
      attempt: 1,
      reason: 'http 500',
      label: 'Teams Chat API GET',
    });
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('secret-thread');
  });

  test('throws UPSTREAM_UNAVAILABLE once a GET exhausts its attempts', async () => {
    withPreCapturedJwt();
    fetchMock.mockImplementation(async () => respond(503, { 'request-id': 'req-503' }));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('teams.microsoft.com returned HTTP 503');
    expect(error.message).toContain('after 3 attempts');
    expect(error.message).toContain('request-id req-503');
    expect(error.message).not.toContain('secret-thread');
    expect(error.details).toEqual({ httpStatus: 503, attempts: 3, requestId: 'req-503' });
  });

  test('reports the single attempt when a Retry-After beyond the wait cap ends a GET early', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(respond(503, { 'Retry-After': '60' }));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryAfterMs).toBe(60_000);
    expect(error.message).toContain('after 1 attempt.');
  });

  test('does not replay a POST on 500 and reports the single attempt', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(respond(500));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT, { method: 'POST', body: { content: 'hi' } }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('after 1 attempt.');
  });

  test('does not replay a PUT without an opt-in and reports the single attempt', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(respond(503));

    const error = await settleError(chatApi(`${MESSAGES_ENDPOINT}/1`, { method: 'PUT', body: { content: 'edited' } }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestInit(0).method).toBe('PUT');
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 1 attempt.');
  });

  test('reports every attempt when the front door refuses a POST three times', async () => {
    withPreCapturedJwt();
    fetchMock.mockImplementation(async () => respond(503, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT, { method: 'POST', body: { content: 'hi' } }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 3 attempts');
  });

  test('replays a POST the front door refused before forwarding it', async () => {
    withPreCapturedJwt();
    fetchMock
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }))
      .mockResolvedValueOnce(respond(500, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }))
      .mockResolvedValueOnce(json({ OriginalArrivalTime: 1 }));

    const data = await settle(
      chatApi<{ OriginalArrivalTime: number }>(MESSAGES_ENDPOINT, { method: 'POST', body: {} }),
    );

    expect(data.OriginalArrivalTime).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('names the front door when it fails the exhausted request', async () => {
    withPreCapturedJwt();
    fetchMock.mockImplementation(async () =>
      respond(500, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL, 'x-proxyerrormessage': 'The network is busy.' }),
    );

    const error = await settleError(chatApi(MESSAGES_ENDPOINT, { method: 'DELETE' }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain("Microsoft's service front door failed the request to teams.microsoft.com");
    expect(error.message).toContain('"The network is busy."');
    expect(error.message).toContain('after 3 attempts');
    expect(error.details).toEqual({ httpStatus: 500, attempts: 3, frontDoorLabel: REQUEST_STAGE_LABEL });
  });

  test('classifies 401 as AUTH_ERROR with the request id and drops the cached JWT', async () => {
    withMsalTokenOnly();
    fetchMock
      .mockResolvedValueOnce(authzOk())
      .mockResolvedValueOnce(respond(401, { 'request-id': 'rid-401' }))
      .mockResolvedValueOnce(authzOk())
      .mockResolvedValueOnce(json({}));

    const error = await settleError(chatApi('/v1/users/ME/conversations'));
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toContain('(request-id rid-401)');
    expect(error.details).toEqual({ httpStatus: 401, requestId: 'rid-401' });

    await settle(chatApi('/v1/users/ME/conversations'));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestUrl(0)).toBe(AUTHZ_URL);
    expect(requestUrl(2)).toBe(AUTHZ_URL);
  });

  test('classifies 429 as RATE_LIMITED and honors Retry-After', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(respond(429, { 'Retry-After': '7' }));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT, { method: 'POST', body: {} }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(7000);
    expect(error.message).toContain('Teams Chat API POST');
    expect(error.message).toContain('(request-id unavailable)');
    expect(error.message).not.toContain('secret-thread');
    expect(error.details).toEqual({ httpStatus: 429 });
  });

  test.each([
    [404, 'NOT_FOUND'],
    [400, 'VALIDATION_ERROR'],
    [501, 'INTERNAL_ERROR'],
  ])('returns %i to the classifier as %s without retrying', async (status, code) => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValue(respond(status, undefined, `error for ${CONVERSATION_ID}`));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('Teams Chat API GET');
    expect(error.message).not.toContain('secret-thread');
    expect(error.details).toEqual({ httpStatus: status });
  });

  test('quotes the nested JSON error envelope of a 4xx, not the endpoint', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'ConversationNotFound', message: `No conversation ${CONVERSATION_ID}` } }, 404, {
        'request-id': 'rid-404',
      }),
    );

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(
      `Teams API not found: Teams Chat API GET — ConversationNotFound: No conversation ${CONVERSATION_ID} (request-id rid-404)`,
    );
    expect(error.message).not.toContain(MESSAGES_ENDPOINT);
    expect(error.details).toEqual({ httpStatus: 404, requestId: 'rid-404' });
  });

  test('quotes a flat errorCode/message envelope and truncates a long message', async () => {
    withPreCapturedJwt();
    const longMessage = 'x'.repeat(400);
    fetchMock.mockResolvedValueOnce(json({ errorCode: 400, message: longMessage }, 400));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT, { method: 'POST', body: {} }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain(`Teams API bad request: Teams Chat API POST — 400: ${'x'.repeat(199)}…`);
    expect(error.message).not.toContain('x'.repeat(200));
  });

  test('reads the top-level fields when `error` is not an object', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(
      json({ error: 'Forbidden', errorCode: 'Unauthorized', message: 'Token rejected' }, 403),
    );

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toBe(
      'Teams API auth error (403): Teams Chat API GET — Unauthorized: Token rejected (request-id unavailable)',
    );
  });

  test('omits the envelope when the 4xx body is not a JSON error object', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(json(['not', 'an', 'envelope'], 403));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toBe('Teams API auth error (403): Teams Chat API GET (request-id unavailable)');
  });

  test('throws NETWORK_ERROR after a GET fails at the network layer on every attempt', async () => {
    withPreCapturedJwt();
    fetchMock.mockRejectedValue(networkFailure());

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.category).toBe('internal');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Network error reaching teams.microsoft.com after 3 attempts: Failed to fetch');
    expect(error.details).toEqual({ attempts: 3 });
  });

  test('throws NETWORK_ERROR after the single attempt when a POST fails at the network layer', async () => {
    withPreCapturedJwt();
    fetchMock.mockRejectedValue(networkFailure());

    const error = await settleError(chatApi(MESSAGES_ENDPOINT, { method: 'POST', body: {} }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe('Network error reaching teams.microsoft.com after 1 attempt: Failed to fetch');
  });

  test('throws TIMEOUT when the request signal times out', async () => {
    withPreCapturedJwt();
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const error = await settleError(chatApi(MESSAGES_ENDPOINT));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toBe('Teams request timed out: Teams Chat API GET');
    expect(error.details).toBeUndefined();
  });
});

describe('createThread', () => {
  test('returns the thread id from the Location header', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(
      respond(201, { Location: `${CHAT_BASE}/v1/threads/19:new-thread@thread.v2` }, null),
    );

    const threadId = await settle(createThread([{ id: '8:live:a', role: 'User' }], { threadType: 'chat' }));

    expect(threadId).toBe('19:new-thread@thread.v2');
    expect(requestUrl(0)).toBe(`${CHAT_BASE}/v1/threads`);
    expect(requestInit(0).method).toBe('POST');
  });

  test('never replays the create POST on 503', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValue(respond(503));

    const error = await settleError(createThread([{ id: '8:live:a', role: 'User' }]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('threadApi', () => {
  test('replays a PUT only when the caller opts in', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(json({}));

    await settle(
      threadApi(CONVERSATION_ID, '/members/8%3Alive%3Ab', {
        method: 'PUT',
        body: { role: 'User' },
        retryNonIdempotent: true,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(0)).toBe(`${CHAT_BASE}/v1/threads/${encodeURIComponent(CONVERSATION_ID)}/members/8%3Alive%3Ab`);
  });

  test('does not replay a DELETE on 503', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValue(respond(503));

    const error = await settleError(threadApi(CONVERSATION_ID, '/members/8%3Alive%3Ab', { method: 'DELETE' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  test('does not replay the topic PUT on a plain 503', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValue(respond(503));

    const error = await settleError(
      threadApi(CONVERSATION_ID, '/properties?name=topic', { method: 'PUT', body: { topic: 'Budget' } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 1 attempt.');
  });

  test('replays the topic PUT the front door refused', async () => {
    withPreCapturedJwt();
    fetchMock
      .mockResolvedValueOnce(respond(503, { 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }))
      .mockResolvedValueOnce(json({}));

    await settle(threadApi(CONVERSATION_ID, '/properties?name=topic', { method: 'PUT', body: { topic: 'Budget' } }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('replays a GET on 502', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValueOnce(respond(502)).mockResolvedValueOnce(json({ id: CONVERSATION_ID }));

    const data = await settle(threadApi<{ id: string }>(CONVERSATION_ID, '?view=msnp24Equivalent'));

    expect(data.id).toBe(CONVERSATION_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Skype JWT exchange', () => {
  test('replays the authsvc POST after a network error and then calls the chat service', async () => {
    withMsalTokenOnly();
    fetchMock.mockRejectedValueOnce(networkFailure()).mockResolvedValueOnce(authzOk()).mockResolvedValueOnce(json({}));

    await settle(chatApi('/v1/users/ME/conversations'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestUrl(0)).toBe(AUTHZ_URL);
    expect(requestUrl(1)).toBe(AUTHZ_URL);
    expect(requestHeaders(0).Authorization).toBe(`Bearer ${MSAL_SKYPE_TOKEN}`);
    expect(requestUrl(2)).toBe(`${CHAT_BASE}/v1/users/ME/conversations`);
  });

  test('getSkypeIdentity surfaces an exhausted network failure as NETWORK_ERROR', async () => {
    withMsalTokenOnly();
    fetchMock.mockRejectedValue(networkFailure());

    const error = await settleError(getSkypeIdentity());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('teams.microsoft.com after 3 attempts');
  });

  test('getSkypeIdentity decodes the enterprise skypeid and reads the captured sign-in name', async () => {
    stubPreScript({ enterpriseToken: capturedToken(MSAL_SKYPE_TOKEN), signInName: SIGN_IN_NAME });
    fetchMock.mockResolvedValueOnce(authzOk());

    const identity = await settle(getSkypeIdentity());

    expect(identity).toEqual({ skypeid: 'live:.cid.abc123', signinname: SIGN_IN_NAME });
  });

  test('getSkypeIdentity fails with AUTH_ERROR and no request when no MSAL token is captured', async () => {
    stubPreScript({});

    const error = await settleError(getSkypeIdentity());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.code).toBe('AUTH_ERROR');
  });
});

describe('substrateSearch', () => {
  test('replays the search POST on 502 and sends bearer plus routing headers', async () => {
    stubPreScript({ substrateToken: capturedToken(SUBSTRATE_TOKEN) });
    fetchMock.mockResolvedValueOnce(respond(502)).mockResolvedValueOnce(json({ EntitySets: [] }));

    const data = await settle(substrateSearch<{ EntitySets: unknown[] }>({ entityRequests: [] }));

    expect(data.EntitySets).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(0)).toBe(SUBSTRATE_URL);
    expect(requestHeaders(0).Authorization).toBe(`Bearer ${SUBSTRATE_TOKEN}`);
    expect(requestHeaders(0)['X-AnchorMailbox']).toBe('PUID:puid-1@tenant-1');
    expect(requestHeaders(0)['X-RoutingParameter-SessionKey']).toBe('OID:oid-1@tenant-1');
  });

  test('fails with AUTH_ERROR and no request when no Substrate token is captured', async () => {
    stubPreScript({});

    const error = await settleError(substrateSearch({}));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.code).toBe('AUTH_ERROR');
  });
});

describe('buildMessageSearchBody', () => {
  test('produces the Teams search bar wire shape for a message query', () => {
    const body = buildMessageSearchBody({ query: 'budget', from: 25, size: 10 });
    const entityRequests = body.entityRequests as Array<Record<string, unknown>>;

    expect(entityRequests).toHaveLength(1);
    expect(entityRequests[0]).toMatchObject({
      entityType: 'Message',
      contentSources: ['Teams'],
      propertySet: 'Optimized',
      query: { queryString: 'budget', displayQueryString: 'budget' },
      from: 25,
      size: 10,
      topResultsCount: 0,
    });
    expect(entityRequests[0]?.fields).toEqual(expect.arrayContaining([expect.stringContaining('SkypeSpaces')]));
    expect(body.scenario).toMatchObject({ Name: 'powerbar' });
    expect(body.cvid).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.logicalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.cvid).not.toBe(body.logicalId);
  });
});

describe('describeTokenSources', () => {
  test('reports every source in order without exposing any secret', async () => {
    stubPreScript({
      enterpriseToken: capturedToken(MSAL_SKYPE_TOKEN, 1800),
      lokiToken: capturedToken(LOKI_TOKEN),
      skypeJwt: capturedToken(SKYPE_JWT),
      substrateToken: capturedToken(SUBSTRATE_TOKEN),
      signInName: SIGN_IN_NAME,
    });
    fetchMock.mockResolvedValueOnce(json({}));
    await settle(chatApi('/v1/users/ME/conversations'));

    const sources = describeTokenSources();
    const serialized = JSON.stringify(sources);

    expect(sources.map(s => s.source)).toEqual([...TEAMS_TOKEN_SOURCES]);
    for (const secret of [MSAL_SKYPE_TOKEN, LOKI_TOKEN, SKYPE_JWT, SUBSTRATE_TOKEN, SIGN_IN_NAME]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('secret');
    for (const source of sources) expect(source.present).toBe(true);

    const msal = sources.find(s => s.source === 'msalSkypeToken');
    expect(msal).toMatchObject({ audienceHost: 'api.spaces.skype.com', expiresInSec: 1800 });
    expect(msal?.fingerprint).toMatch(/^[0-9a-f]{4}$/);

    expect(sources.find(s => s.source === 'lokiToken')?.audienceHost).toBe('394866fc-eedb-4f01-8536-3ff84b16be2a');
    expect(sources.find(s => s.source === 'skypeJwtPreScript')?.audienceHost).toBeNull();

    const cache = sources.find(s => s.source === 'skypeJwtCache');
    expect(cache?.fingerprint).toBe(sources.find(s => s.source === 'skypeJwtPreScript')?.fingerprint);
    expect(cache?.expiresInSec).toBe(3600);

    expect(sources.find(s => s.source === 'signInName')).toEqual({
      source: 'signInName',
      present: true,
      expiresInSec: null,
      audienceHost: null,
      fingerprint: null,
    });
  });

  test('reports absent sources as not present with null details', () => {
    stubPreScript({});

    const sources = describeTokenSources();

    expect(sources).toHaveLength(TEAMS_TOKEN_SOURCES.length);
    for (const source of sources) {
      expect(source).toMatchObject({ present: false, expiresInSec: null, audienceHost: null, fingerprint: null });
    }
  });

  test('distinguishes two tokens by fingerprint and reports an expired one with a negative expiry', () => {
    stubPreScript({
      enterpriseToken: capturedToken(MSAL_SKYPE_TOKEN, -120),
      substrateToken: capturedToken(SUBSTRATE_TOKEN),
    });

    const sources = describeTokenSources();
    const msal = sources.find(s => s.source === 'msalSkypeToken');
    const substrate = sources.find(s => s.source === 'substrateToken');

    expect(msal?.present).toBe(true);
    expect(msal?.expiresInSec).toBe(-120);
    expect(msal?.fingerprint).not.toBe(substrate?.fingerprint);
  });
});

describe('probes', () => {
  test('probeChatService records a failing status after a single attempt', async () => {
    withPreCapturedJwt();
    fetchMock.mockResolvedValue(respond(500, { 'request-id': 'probe-rid', 'x-proxyerrorlabel': REQUEST_STAGE_LABEL }));

    const result = await settle(probeChatService(authsvcSkipped()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      name: 'chatsvc',
      path: '/v1/users/ME/conversations',
      status: 500,
      ok: false,
      requestId: 'probe-rid',
      frontDoor: REQUEST_STAGE_LABEL,
      error: null,
    });
    expect(requestUrl(0)).toBe(
      `${CHAT_BASE}/v1/users/ME/conversations?view=superchat&pageSize=1&startTime=0&targetType=Thread%7CPassport`,
    );
  });

  test('probeChatService reports the authsvc probe error when no credential was captured, without a request', async () => {
    stubPreScript({});

    const authsvc = await settle(probeAuthz());
    const result = await settle(probeChatService(authsvc));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBeNull();
    expect(result.error).toContain('Skype JWT unavailable: ToolError: Not authenticated');
    expect(result.error).toContain('no Skype API access token captured');
  });

  test('probeChatService reports a failed authsvc probe as its own step without exchanging again', async () => {
    withMsalTokenOnly();
    fetchMock.mockImplementation(async () => respond(503, { 'request-id': 'authz-rid' }));

    const authsvc = await settle(probeAuthz());
    const result = await settle(probeChatService(authsvc));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(0)).toBe(AUTHZ_URL);
    expect(authsvc).toMatchObject({ name: 'authsvc', status: 503, ok: false, requestId: 'authz-rid', error: null });
    expect(result).toMatchObject({ name: 'chatsvc', path: '/v1/users/ME/conversations', status: null, ok: false });
    expect(result.error).toBe(
      'ToolError: Skype JWT unavailable: the authsvc probe received HTTP 503 without a Skype JWT',
    );
  });

  test('probeChatService sends the JWT the authsvc probe minted, so the exchange runs once', async () => {
    withMsalTokenOnly();
    fetchMock.mockResolvedValueOnce(authzOk()).mockResolvedValueOnce(json({}, 200, { 'request-id': 'chat-rid' }));

    const authsvc = await settle(probeAuthz());
    const result = await settle(probeChatService(authsvc));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(0)).toBe(AUTHZ_URL);
    expect(requestUrl(1)).toContain(`${CHAT_BASE}/v1/users/ME/conversations`);
    expect(requestHeaders(1).Authentication).toBe(`skypetoken=${SKYPE_JWT}`);
    expect(authsvc).toMatchObject({ status: 200, ok: true, error: null });
    expect(result).toMatchObject({ status: 200, ok: true, requestId: 'chat-rid', error: null });
    expect(describeTokenSources().find(source => source.source === 'skypeJwtCache')?.present).toBe(true);
  });

  test('probeChatService reuses a cached JWT rather than exchanging', async () => {
    withMsalTokenOnly();
    fetchMock.mockResolvedValueOnce(authzOk()).mockResolvedValue(json({}));
    await settle(chatApi('/v1/users/ME/properties'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const result = await settle(probeChatService(authsvcSkipped()));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestUrl(2)).toContain(`${CHAT_BASE}/v1/users/ME/conversations`);
    expect(requestHeaders(2).Authentication).toBe(`skypetoken=${SKYPE_JWT}`);
    expect(result).toMatchObject({ status: 200, ok: true, error: null });
  });

  test('probeChatService reports a 2xx authsvc response that carried no JWT', async () => {
    withMsalTokenOnly();
    fetchMock.mockResolvedValueOnce(json({ tokens: {} }));

    const authsvc = await settle(probeAuthz());
    const result = await settle(probeChatService(authsvc));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authsvc).toMatchObject({ status: 200, ok: true, error: null });
    expect(result.status).toBeNull();
    expect(result.error).toBe(
      'ToolError: Skype JWT unavailable: the authsvc probe received HTTP 200 without a Skype JWT',
    );
    expect(describeTokenSources().find(source => source.source === 'skypeJwtCache')?.present).toBe(false);
  });

  test('probeSubstrate is skipped without a Substrate token', async () => {
    stubPreScript({});

    const result = await settle(probeSubstrate());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: 'substrate', path: '/searchservice/api/v2/query', status: null, ok: false });
    expect(result.error).toContain('no Substrate Search token captured');
  });

  test('probeSubstrate posts a one-result search and records the response', async () => {
    stubPreScript({ substrateToken: capturedToken(SUBSTRATE_TOKEN) });
    fetchMock.mockResolvedValueOnce(json({ EntitySets: [] }, 200, { 'request-id': 'sub-rid' }));

    const result = await settle(probeSubstrate());

    expect(result).toMatchObject({ status: 200, ok: true, requestId: 'sub-rid', error: null });
    const body = JSON.parse(String(requestInit(0).body)) as { entityRequests: Array<{ size: number; query: unknown }> };
    expect(body.entityRequests[0]).toMatchObject({ size: 1, query: { queryString: '*' } });
  });

  test('probeAuthz reports the missing MSAL token without a request, and records the exchange when present', async () => {
    stubPreScript({});
    const skipped = await settle(probeAuthz());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(skipped).toMatchObject({ name: 'authsvc', path: '/api/authsvc/v1.0/authz', status: null });
    expect(skipped.error).toContain('no Skype API access token captured');

    withMsalTokenOnly();
    fetchMock.mockResolvedValueOnce(authzOk());
    const probed = await settle(probeAuthz());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(0)).toBe(AUTHZ_URL);
    expect(probed).toMatchObject({ status: 200, ok: true, error: null });
  });

  test('probe results carry endpoint labels, never URLs or ids', async () => {
    withPreCapturedJwt({ substrateToken: capturedToken(SUBSTRATE_TOKEN) });
    fetchMock.mockResolvedValue(json({}));

    const authsvc = await settle(probeAuthz());
    const results = await settle(Promise.all([probeChatService(authsvc), probeSubstrate()]));
    const serialized = JSON.stringify([authsvc, ...results]);

    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain(SKYPE_JWT);
    expect(serialized).not.toContain(SUBSTRATE_TOKEN);
  });
});
