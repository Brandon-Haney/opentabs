/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://contoso.sharepoint.com/:x:/r/sites/finance/Shared%20Documents/Book.xlsx?sourcedoc=%7Babc%7D&wdrldr=SessionExpired&wdrldc=1"}
 */
import { getCurrentUrl } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { diagnose } from './diagnose.js';

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getCurrentUrl: vi.fn((): string => location.href),
}));

const LS_TOKEN_KEY = '__opentabs_excel_graph_token';
const TOKEN =
  'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL2dyYXBoLm1pY3Jvc29mdC5jb20iLCJzY3AiOiJGaWxlcy5SZWFkIn0.sig-value';

const setPreScriptNamespace = (values: Record<string, unknown> | undefined): void => {
  Object.assign(globalThis, {
    __openTabs: values === undefined ? undefined : { preScript: { 'excel-online': values } },
  });
};

const stubMirrorToken = (): void => {
  localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token: TOKEN, exp: Math.floor(Date.now() / 1000) + 3600 }));
};

const respond = (status: number, headers?: Record<string, string>): Response =>
  new Response(status === 204 ? null : `{"id":"x"}`, { status, headers });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getCurrentUrl).mockImplementation(() => location.href);
  localStorage.clear();
  setPreScriptNamespace(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnose', () => {
  test('reports a SharePoint workbook with both probes, and its output satisfies the declared schema', async () => {
    stubMirrorToken();
    fetchMock.mockResolvedValue(respond(200, { 'request-id': 'r-1' }));
    const output = await diagnose.handle({});

    expect(diagnose.output.parse(output)).toEqual(output);
    expect(output.pageOrigin).toBe('https://contoso.sharepoint.com');
    expect(output.pageKind).toBe('sharepoint');
    expect(output.activeSource).toBe('localStorageMirror');
    expect(output.tokenSources.map(source => [source.source, source.present])).toEqual([
      ['preScript', false],
      ['localStorageMirror', true],
      ['msalPlaintext', false],
    ]);
    expect(output.tokenSources[1]).toMatchObject({ audience: 'graph.microsoft.com', scopes: ['Files.Read'] });
    expect(output.workbookContext).toEqual({ available: true, source: 'shares' });
    expect(output.reloadMarker).toEqual({ reason: 'SessionExpired', count: 1, subcode: null });
    expect(output.apiBase).toBe('https://graph.microsoft.com/v1.0');
    expect(output.probes.map(probe => [probe.name, probe.path, probe.status, probe.requestId])).toEqual([
      ['graph:/me', '/me', 200, 'r-1'],
      ['graph:/shares', '/shares/{shareId}/driveItem', 200, 'r-1'],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('never exposes the token, the page path, the query or an encoded share id', async () => {
    stubMirrorToken();
    fetchMock.mockResolvedValue(respond(200));
    const serialized = JSON.stringify(await diagnose.handle({}));
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('sig-value');
    expect(serialized).not.toContain('/sites/finance');
    expect(serialized).not.toContain('Book.xlsx');
    expect(serialized).not.toContain('sourcedoc');
    expect(serialized).not.toContain('wdrldr');
    expect(serialized).not.toContain('u!');
    expect(serialized).not.toContain('?');
  });

  test('still resolves with no token: every source absent and each probe carrying the auth error', async () => {
    const output = await diagnose.handle({});
    expect(diagnose.output.parse(output)).toEqual(output);
    expect(output.activeSource).toBeNull();
    expect(output.tokenSources.every(source => !source.present)).toBe(true);
    expect(output.probes).toHaveLength(2);
    for (const probe of output.probes) {
      expect(probe.status).toBeNull();
      expect(probe.ok).toBe(false);
      expect(probe.error).toContain('Not authenticated');
    }
    expect(output.workbookContext).toEqual({ available: false, source: 'shares' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('issues each probe exactly once even when it fails', async () => {
    stubMirrorToken();
    fetchMock.mockResolvedValue(
      respond(500, { 'x-proxyerrorlabel': 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest' }),
    );
    const output = await diagnose.handle({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output.probes.map(probe => probe.status)).toEqual([500, 500]);
    expect(output.probes[0]?.frontDoor).toBe('Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest');
    expect(output.workbookContext).toEqual({ available: false, source: 'shares' });
  });

  test('prefers the reload marker the pre-script captured over the URL', async () => {
    setPreScriptNamespace({ reloadMarker: { reason: 'Captured', count: 3, subcode: 'sc', capturedAt: 1 } });
    const output = await diagnose.handle({});
    expect(output.reloadMarker).toEqual({ reason: 'Captured', count: 3, subcode: 'sc' });
  });

  test('reports the cloud app with a URL-located workbook and a single probe', async () => {
    vi.mocked(getCurrentUrl).mockReturnValue('https://excel.cloud.microsoft/open/onedrive/?driveId=d1&docId=i1');
    stubMirrorToken();
    fetchMock.mockResolvedValue(respond(200));
    const output = await diagnose.handle({});
    expect(output.pageOrigin).toBe('https://excel.cloud.microsoft');
    expect(output.pageKind).toBe('cloud-app');
    expect(output.workbookContext).toEqual({ available: true, source: 'url' });
    expect(output.reloadMarker).toBeNull();
    expect(output.probes.map(probe => probe.name)).toEqual(['graph:/me']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports a page that is not a workbook', async () => {
    vi.mocked(getCurrentUrl).mockReturnValue('https://excel.cloud.microsoft/');
    const output = await diagnose.handle({});
    expect(output.pageKind).toBe('cloud-app');
    expect(output.workbookContext).toEqual({ available: false, source: null });
    vi.mocked(getCurrentUrl).mockReturnValue('https://www.office.com/launch/excel');
    expect((await diagnose.handle({})).pageKind).toBe('other');
  });
});
