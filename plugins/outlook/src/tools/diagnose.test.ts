/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://outlook.cloud.microsoft/mail/"}
 */
import { setAuthCache } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GRAPH_API_BASE, OUTLOOK_API_BASE } from '../auth-candidates.js';
import { rememberRejected, resetCascadeMemory } from '../auth-cascade-memory.js';
import { describeCachedAuth, describeRejectedAuth } from '../outlook-api.js';
import { tokenFingerprint } from '../token-fingerprint.js';
import { diagnose } from './diagnose.js';

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ENTERPRISE_CLIENT_ID = '9199bf20-a13f-4107-85dc-02114787ef48';
const GRAPH_TOKEN = 'graph-token-secret';
const REST_TOKEN = 'rest-token-secret';

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

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  localStorage.clear();
  resetTokenCache();
  resetCascadeMemory();
  seedTokens();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnose', () => {
  test('is registered under Account as a read-only tool with a summary', () => {
    expect(diagnose.name).toBe('diagnose');
    expect(diagnose.group).toBe('Account');
    expect(diagnose.summary).toBe('Diagnose Microsoft API connectivity');
    expect(diagnose.description).not.toContain('\n');
  });

  test('reports origin, token sources, caches, rejections and one probe per base, matching its own schema', async () => {
    setAuthCache('outlook', { token: REST_TOKEN, apiBase: OUTLOOK_API_BASE });
    rememberRejected('outlook', { token: GRAPH_TOKEN, apiBase: GRAPH_API_BASE }, 1_800_000_000_000);
    fetchMock.mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith(GRAPH_API_BASE)) return new Response(null, { status: 403, headers: { 'request-id': 'g-1' } });
      if (url.startsWith(OUTLOOK_API_BASE)) return new Response(null, { status: 200 });
      return new Response(null, { status: 500, headers: { 'x-proxyerrorlabel': 'Proxy::OnHttpRequest' } });
    });

    const output = await diagnose.handle({});
    expect(diagnose.output.parse(output)).toEqual(output);

    expect(output.pageOrigin).toBe('https://outlook.cloud.microsoft');
    expect(output.cachedApiBase).toBe(OUTLOOK_API_BASE);
    expect(output.cachedSlots).toEqual([
      { slot: 'mail', apiBase: OUTLOOK_API_BASE, fingerprint: tokenFingerprint(REST_TOKEN), expiresAt: null },
    ]);
    expect(output.rejected).toEqual([
      {
        slot: 'mail',
        apiBase: GRAPH_API_BASE,
        fingerprint: tokenFingerprint(GRAPH_TOKEN),
        rejectedAt: new Date(1_800_000_000_000).toISOString(),
      },
    ]);
    expect(output.tokenSources.filter(source => source.present).map(source => source.audienceHost)).toEqual([
      'graph.microsoft.com',
      'outlook.office.com',
    ]);
    expect(output.probes.map(probe => [probe.name, probe.status, probe.requestId, probe.frontDoor])).toEqual([
      ['graph', 403, 'g-1', null],
      ['outlook-rest', 200, null, null],
      ['ows', 500, null, 'Proxy::OnHttpRequest'],
    ]);
    expect(output.probes.map(probe => probe.tokenFingerprint)).toEqual([
      tokenFingerprint(GRAPH_TOKEN),
      tokenFingerprint(REST_TOKEN),
      tokenFingerprint(GRAPH_TOKEN),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(output)).not.toMatch(/token-secret/);
  });

  test('changes neither the auth cache nor the cascade memory', async () => {
    setAuthCache('outlook', { token: REST_TOKEN, apiBase: OUTLOOK_API_BASE });
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const cachedBefore = describeCachedAuth();
    const rejectedBefore = describeRejectedAuth();

    await diagnose.handle({});

    expect(describeCachedAuth()).toEqual(cachedBefore);
    expect(describeRejectedAuth()).toEqual(rejectedBefore);
  });

  test('still answers when no token exists at all', async () => {
    localStorage.clear();
    const output = await diagnose.handle({});
    expect(output.cachedApiBase).toBeNull();
    expect(output.tokenSources.every(source => !source.present)).toBe(true);
    expect(output.probes.every(probe => probe.status === null && probe.error?.includes('No candidate token'))).toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
