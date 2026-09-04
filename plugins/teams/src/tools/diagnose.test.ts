/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://teams.microsoft.com/v2/"}
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearCaches, TEAMS_TOKEN_SOURCES } from '../teams-api.js';
import { diagnose } from './diagnose.js';

const base64url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const jwt = (claims: Record<string, unknown>, marker: string): string =>
  `${base64url(JSON.stringify({ alg: 'none' }))}.${base64url(JSON.stringify(claims))}.${marker}`;

const MSAL_SKYPE_TOKEN = jwt({ aud: 'https://api.spaces.skype.com' }, 'msal-skype-secret');
const SKYPE_JWT = jwt({ skypeid: 'live:.cid.abc123' }, 'skype-jwt-secret');
const SUBSTRATE_TOKEN = jwt({ aud: 'https://substrate.office.com', tid: 't', puid: 'p', oid: 'o' }, 'substrate-secret');
const SIGN_IN_NAME = 'someone@contoso.com';

const capturedToken = (secret: string): { secret: string; expiresOn: number } => ({
  secret,
  expiresOn: Math.floor(Date.now() / 1000) + 3600,
});

const json = (payload: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

/** Whether a fetch input targets the enterprise authsvc token exchange on the page origin. */
const isAuthzRequest = (input: unknown): boolean =>
  String(input) === 'https://teams.microsoft.com/api/authsvc/v1.0/authz';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  clearCaches();
});

afterEach(() => {
  clearCaches();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnose', () => {
  test('is a read-only People tool with a summary', () => {
    expect(diagnose.name).toBe('diagnose');
    expect(diagnose.group).toBe('People');
    expect(diagnose.summary?.length ?? 0).toBeGreaterThan(0);
    expect(diagnose.description.length).toBeLessThanOrEqual(1000);
  });

  test('reports the page origin, environment, token inventory and one probe per API base', async () => {
    vi.stubGlobal('__openTabs', {
      preScript: {
        teams: {
          skypeJwt: capturedToken(SKYPE_JWT),
          substrateToken: capturedToken(SUBSTRATE_TOKEN),
          signInName: SIGN_IN_NAME,
        },
      },
    });
    fetchMock.mockImplementation(async () => json({}, { 'request-id': 'diag-rid' }));

    const output = await diagnose.handle({});

    expect(diagnose.output.parse(output)).toEqual(output);
    expect(output.pageOrigin).toBe('https://teams.microsoft.com');
    expect(output.environment).toBe('enterprise');
    expect(output.chatServiceOrigin).toBe('https://teams.microsoft.com');
    expect(output.cachedApiBase).toBeNull();
    expect(output.tokenSources.map(s => s.source)).toEqual([...TEAMS_TOKEN_SOURCES]);
    expect(output.probes.map(p => p.name)).toEqual(['authsvc', 'chatsvc', 'substrate']);

    const byName = new Map(output.probes.map(p => [p.name, p]));
    expect(byName.get('authsvc')).toMatchObject({ status: null, ok: false });
    expect(byName.get('authsvc')?.error).toContain('no Skype API access token captured');
    expect(byName.get('chatsvc')).toMatchObject({ status: 200, ok: true, requestId: 'diag-rid', error: null });
    expect(byName.get('substrate')).toMatchObject({ status: 200, ok: true, requestId: 'diag-rid', error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('never returns a secret, the sign-in name, or a URL carrying ids', async () => {
    vi.stubGlobal('__openTabs', {
      preScript: {
        teams: {
          skypeJwt: capturedToken(SKYPE_JWT),
          substrateToken: capturedToken(SUBSTRATE_TOKEN),
          signInName: SIGN_IN_NAME,
        },
      },
    });
    fetchMock.mockImplementation(async () => json({}));
    // Probes are single-attempt, so the SDK's retry warning (console-bound outside the adapter runtime) never fires.
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const serialized = JSON.stringify(await diagnose.handle({}));

    expect(serialized).not.toContain(SKYPE_JWT);
    expect(serialized).not.toContain(SUBSTRATE_TOKEN);
    expect(serialized).not.toContain(SIGN_IN_NAME);
    expect(serialized).not.toContain('secret');
    expect(serialized.match(/https:\/\//g)).toHaveLength(2);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  test('on classic Teams exchanges the MSAL token once and probes the chat service with the minted JWT', async () => {
    vi.stubGlobal('__openTabs', {
      preScript: {
        teams: { enterpriseToken: capturedToken(MSAL_SKYPE_TOKEN), substrateToken: capturedToken(SUBSTRATE_TOKEN) },
      },
    });
    fetchMock.mockImplementation(async input =>
      isAuthzRequest(input) ? json({ tokens: { skypeToken: SKYPE_JWT, expiresIn: 3600 } }) : json({}),
    );

    const output = await diagnose.handle({});

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([input]) => isAuthzRequest(input))).toHaveLength(1);
    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/v1/users/ME/conversations'));
    expect((chatCall?.[1]?.headers as Record<string, string>).Authentication).toBe(`skypetoken=${SKYPE_JWT}`);
    const byName = new Map(output.probes.map(p => [p.name, p]));
    expect(byName.get('authsvc')).toMatchObject({ status: 200, ok: true, error: null });
    expect(byName.get('chatsvc')).toMatchObject({ status: 200, ok: true, error: null });
    expect(byName.get('substrate')).toMatchObject({ status: 200, ok: true, error: null });
    expect(output.tokenSources.find(s => s.source === 'skypeJwtCache')?.present).toBe(true);
  });

  test('on classic Teams reports a failed exchange on the chat-service probe without exchanging again', async () => {
    vi.stubGlobal('__openTabs', { preScript: { teams: { enterpriseToken: capturedToken(MSAL_SKYPE_TOKEN) } } });
    fetchMock.mockImplementation(
      async () => new Response('busy', { status: 503, headers: { 'request-id': 'authz-rid' } }),
    );

    const output = await diagnose.handle({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isAuthzRequest(fetchMock.mock.calls[0]?.[0])).toBe(true);
    const byName = new Map(output.probes.map(p => [p.name, p]));
    expect(byName.get('authsvc')).toMatchObject({ status: 503, ok: false, requestId: 'authz-rid', error: null });
    expect(byName.get('chatsvc')).toMatchObject({ status: null, ok: false });
    expect(byName.get('chatsvc')?.error).toContain('Skype JWT unavailable');
    expect(byName.get('chatsvc')?.error).toContain('HTTP 503');
  });

  test('marks every source absent and every probe skipped when nothing was captured', async () => {
    vi.stubGlobal('__openTabs', { preScript: { teams: {} } });

    const output = await diagnose.handle({});

    expect(fetchMock).not.toHaveBeenCalled();
    for (const source of output.tokenSources) expect(source.present).toBe(false);
    for (const probe of output.probes) {
      expect(probe.status).toBeNull();
      expect(probe.error).not.toBeNull();
    }
  });
});
