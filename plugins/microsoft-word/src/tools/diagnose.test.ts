/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://contoso.sharepoint.com/:w:/r/sites/x/Shared%20Documents/doc.docx?d=wabc123&csf=1&web=1"}
 */
import { getCurrentUrl, log } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { diagnose } from './diagnose.js';

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getCurrentUrl: vi.fn(() => window.location.href),
}));

const SHAREPOINT_URL = 'https://contoso.sharepoint.com/:w:/r/sites/x/Shared%20Documents/doc.docx?d=wabc123&csf=1&web=1';
const CLOUD_APP_URL = 'https://word.cloud.microsoft/open/abc?driveId=drive-1&docId=item-1';
const LS_TOKEN_KEY = '__opentabs_word_graph_token';
const TOKEN =
  'eyJhbGciOiJub25lIn0.eyJhdWQiOiJodHRwczovL2dyYXBoLm1pY3Jvc29mdC5jb20ifQ.mirror-signature-0123456789abcdef';
const SHARE_ID_PREFIX = 'u!';

type OpenTabsGlobal = { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } };
const setNamespace = (values: Record<string, unknown> | undefined): void => {
  (globalThis as OpenTabsGlobal).__openTabs =
    values === undefined ? undefined : { preScript: { 'microsoft-word': values } };
};

const respond = (status: number, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify({ id: 'x' }), { status, headers: { 'content-type': 'application/json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token: TOKEN, exp: Math.floor(Date.now() / 1000) + 3600 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(getCurrentUrl).mockReset();
  vi.mocked(log.warn).mockClear();
  localStorage.clear();
  setNamespace(undefined);
});

describe('diagnose', () => {
  test('produces output that parses against its own schema on a SharePoint document', async () => {
    fetchMock.mockResolvedValue(respond(200, { 'request-id': 'req-ok' }));
    const output = await diagnose.handle({});
    expect(() => diagnose.output.parse(output)).not.toThrow();
    expect(output).toMatchObject({
      pageOrigin: 'https://contoso.sharepoint.com',
      pageKind: 'sharepoint',
      apiBase: 'https://graph.microsoft.com/v1.0',
      activeSource: 'localStorageMirror',
      documentContext: { available: true, source: 'shares' },
      reloadMarker: null,
    });
    expect(output.probes.map(p => p.name)).toEqual(['graph:/me', 'graph:/shares']);
    expect(output.probes.every(p => p.status === 200 && p.ok && p.requestId === 'req-ok')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('never includes the token, the document path or an encoded share id', async () => {
    fetchMock.mockResolvedValue(respond(200));
    const serialized = JSON.stringify(await diagnose.handle({}));
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('/sites/x');
    expect(serialized).not.toContain('doc.docx');
    expect(serialized).not.toContain('wabc123');
    expect(serialized).not.toContain(SHARE_ID_PREFIX);
    expect(serialized).not.toContain('?');
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`/shares/${SHARE_ID_PREFIX}`);
  });

  test('resolves with absent sources and errored probes when no token exists', async () => {
    localStorage.clear();
    const output = await diagnose.handle({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output.activeSource).toBeNull();
    expect(output.tokenSources.every(s => !s.present && s.fingerprint === null)).toBe(true);
    expect(output.documentContext).toEqual({ available: false, source: 'shares' });
    for (const probe of output.probes) {
      expect(probe.status).toBeNull();
      expect(probe.error).toContain('Not authenticated');
    }
  });

  test('issues each probe exactly once even when the upstream answers 500', async () => {
    fetchMock.mockResolvedValue(
      respond(500, {
        'request-id': 'req-500',
        'x-proxyerrorlabel': 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest',
      }),
    );
    const output = await diagnose.handle({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output.documentContext.available).toBe(false);
    for (const probe of output.probes) {
      expect(probe).toMatchObject({ status: 500, ok: false, requestId: 'req-500', error: null });
      expect(probe.frontDoor).toContain('OnHttpRequest');
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('probes only /me on the standalone app and reads document ids from the URL', async () => {
    vi.mocked(getCurrentUrl).mockReturnValue(CLOUD_APP_URL);
    fetchMock.mockResolvedValue(respond(200));
    const output = await diagnose.handle({});
    expect(output).toMatchObject({
      pageOrigin: 'https://word.cloud.microsoft',
      pageKind: 'cloud-app',
      documentContext: { available: true, source: 'url' },
    });
    expect(output.probes.map(p => p.name)).toEqual(['graph:/me']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output)).not.toContain('drive-1');
  });

  test('reports the reload marker the pre-script captured, else the one on the URL, else null', async () => {
    fetchMock.mockResolvedValue(respond(200));
    setNamespace({ reloadMarker: { reason: 'SessionExpired', count: 2, subcode: 'abc', capturedAt: 1 } });
    expect((await diagnose.handle({})).reloadMarker).toEqual({ reason: 'SessionExpired', count: 2, subcode: 'abc' });

    setNamespace(undefined);
    vi.mocked(getCurrentUrl).mockReturnValue(`${SHAREPOINT_URL}&wdrldr=Reload&wdrldc=1`);
    expect((await diagnose.handle({})).reloadMarker).toEqual({ reason: 'Reload', count: 1, subcode: null });

    vi.mocked(getCurrentUrl).mockReturnValue(SHAREPOINT_URL);
    expect((await diagnose.handle({})).reloadMarker).toBeNull();
  });
});
