/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://contoso.sharepoint.com/:p:/r/sites/secret-site/deck.pptx?wdrldr=SessionExpired&wdrldc=1"}
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { encodeShareId, GRAPH_BASE } from '../powerpoint-api.js';
import { clearAllSessions, storeSession } from '../session.js';
import { diagnose } from './diagnose.js';

const TOKEN = 'eyJhbGciOiJub25lIn0.eyJhdWQiOiJodHRwczovL2dyYXBoLm1pY3Jvc29mdC5jb20ifQ.sig';
const PAGE_ORIGIN = 'https://contoso.sharepoint.com';

type OpenTabsGlobal = { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } };
type WopiGlobal = {
  _wopiContextJson?: { DriveId?: string; DriveItemId?: string; WopiAction?: string; ReadOnly?: boolean };
};
type PageContextGlobal = { _spPageContextInfo?: Record<string, unknown> };

const setNamespace = (values: Record<string, unknown>): void => {
  (globalThis as OpenTabsGlobal).__openTabs = { preScript: { powerpoint: values } };
};
const stubToken = (extra: Record<string, unknown> = {}): void =>
  setNamespace({ graph: { token: TOKEN, exp: Math.floor(Date.now() / 1000) + 3600 }, ...extra });

const respond = (status: number, headers?: Record<string, string>): Response =>
  new Response(`body-${status}`, { status, headers });

const urls = (): string[] => fetchMock.mock.calls.map(([input]) => String(input));

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  clearAllSessions();
  localStorage.clear();
  delete (globalThis as OpenTabsGlobal).__openTabs;
  delete (globalThis as WopiGlobal)._wopiContextJson;
  delete (globalThis as PageContextGlobal)._spPageContextInfo;
  history.replaceState(null, '', '/:p:/r/sites/secret-site/deck.pptx?wdrldr=SessionExpired&wdrldc=1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnose', () => {
  test('describes the page, tokens, drive resolution and probes without leaking the token, path or share id', async () => {
    stubToken();
    fetchMock
      .mockResolvedValueOnce(respond(200, { 'request-id': 'req-me' }))
      .mockResolvedValueOnce(respond(200, { 'client-request-id': 'req-shares' }));

    const output = diagnose.output.parse(await diagnose.handle({}));

    expect(output.pageOrigin).toBe(PAGE_ORIGIN);
    expect(output.pageKind).toBe('sharepoint');
    expect(output.identity).toEqual({ kind: 'unknown', tenantId: null, canEdit: null });
    expect(output.apiBase).toBe(GRAPH_BASE);
    expect(output.activeSource).toBe('preScript');
    expect(output.tokenSources.map(s => [s.source, s.present])).toEqual([
      ['preScript', true],
      ['localStorageMirror', false],
      ['msalPlaintext', false],
    ]);
    expect(output.presentationContext).toEqual({ available: true, driveIdSource: 'shares', itemIdFromWopi: false });
    expect(output.reloadMarker).toEqual({ reason: 'SessionExpired', count: 1, subcode: null });
    expect(output.openSessions).toBe(0);
    expect(output.probes.map(p => [p.name, p.path, p.status, p.requestId])).toEqual([
      ['graph:/me', '/me', 200, 'req-me'],
      ['graph:/shares', '/shares/{shareId}/driveItem', 200, 'req-shares'],
    ]);

    expect(urls()[0]).toBe(`${GRAPH_BASE}/me?%24select=id`);
    expect(urls()[1]).toContain(`${GRAPH_BASE}/shares/${encodeShareId(location.href)}/driveItem`);

    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('u!');
    expect(serialized).not.toContain(encodeShareId(location.href));
    expect(serialized).not.toContain('secret-site');
    expect(serialized).not.toContain('deck.pptx');
    expect(serialized).not.toContain('wdrldr');
    expect(serialized).not.toContain('?');
  });

  test('still resolves with every source absent and auth errors in the probes when no token exists', async () => {
    const output = diagnose.output.parse(await diagnose.handle({}));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output.activeSource).toBeNull();
    expect(output.tokenSources.every(s => !s.present)).toBe(true);
    expect(output.presentationContext).toEqual({ available: false, driveIdSource: null, itemIdFromWopi: false });
    expect(output.probes).toHaveLength(2);
    for (const probe of output.probes) {
      expect(probe.status).toBeNull();
      expect(probe.ok).toBe(false);
      expect(probe.error).toContain('Not authenticated');
    }
  });

  test('on an anonymous sharing-link page the probe says Graph is unreachable there, never to reauthenticate', async () => {
    (globalThis as PageContextGlobal)._spPageContextInfo = { isAnonymousGuestUser: true, aadTenantId: 'host-tenant' };
    (globalThis as WopiGlobal)._wopiContextJson = {
      DriveId: 'DRIVE-WOPI',
      DriveItemId: 'ITEM-WOPI',
      WopiAction: 'Edit',
      ReadOnly: false,
    };
    const output = diagnose.output.parse(await diagnose.handle({}));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output.identity).toEqual({ kind: 'anonymous-link', tenantId: 'host-tenant', canEdit: true });
    expect(output.probes.map(p => p.name)).toEqual(['graph:/me']);
    expect(output.probes[0]?.error).toContain('anonymous sharing link');
    expect(output.probes[0]?.error).not.toContain('reauthenticate` to recover');
  });

  test('issues each probe exactly once even when it fails with 500', async () => {
    stubToken();
    fetchMock.mockResolvedValue(respond(500, { 'request-id': 'req-500' }));
    const output = diagnose.output.parse(await diagnose.handle({}));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output.probes.map(p => [p.status, p.ok, p.requestId])).toEqual([
      [500, false, 'req-500'],
      [500, false, 'req-500'],
    ]);
    expect(output.presentationContext).toEqual({ available: false, driveIdSource: null, itemIdFromWopi: false });
  });

  test('skips the /shares probe when the page exposes the drive id, and reads the WOPI item id', async () => {
    stubToken();
    (globalThis as WopiGlobal)._wopiContextJson = { DriveId: 'DRIVE-WOPI', DriveItemId: 'ITEM-WOPI' };
    fetchMock.mockResolvedValueOnce(respond(200));
    const output = diagnose.output.parse(await diagnose.handle({}));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output.probes.map(p => p.name)).toEqual(['graph:/me']);
    expect(output.presentationContext).toEqual({ available: true, driveIdSource: 'wopi', itemIdFromWopi: true });
    expect(JSON.stringify(output)).not.toContain('ITEM-WOPI');
  });

  test('prefers the reload marker the pre-script captured over the URL, and reports null without either', async () => {
    stubToken({ reloadMarker: { reason: 'Captured', count: 4, subcode: 'sc', capturedAt: 1 } });
    fetchMock.mockResolvedValue(respond(200));
    expect((await diagnose.handle({})).reloadMarker).toEqual({ reason: 'Captured', count: 4, subcode: 'sc' });

    stubToken();
    history.replaceState(null, '', '/:p:/r/sites/secret-site/deck.pptx');
    expect((await diagnose.handle({})).reloadMarker).toBeNull();
  });

  test('counts open batched edit sessions and identifies the cloud app', async () => {
    stubToken();
    fetchMock.mockResolvedValue(respond(200));
    storeSession({
      driveId: 'd',
      itemId: 'i',
      entries: new Map(),
      etag: '"e"',
      openedAt: Date.now(),
      lastAccessedAt: Date.now(),
      dirty: true,
    });
    const output = await diagnose.handle({});
    expect(output.openSessions).toBe(1);
    expect(output.pageKind).toBe('sharepoint');
  });
});
