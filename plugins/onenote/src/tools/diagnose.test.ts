/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clearTokenSources,
  installMsalToken,
  installPreScriptToken,
  makeGraphToken,
  nowSec,
} from '../test-support/tokens.js';
import { diagnose } from './diagnose.js';

/** The page URL the SDK's getCurrentUrl reports; jsdom cannot change origin, so the SDK export is replaced. */
const page = vi.hoisted(() => ({ url: 'https://onenote.cloud.microsoft/' }));

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  getCurrentUrl: () => page.url,
}));

const SHAREPOINT_URL =
  'https://contoso.sharepoint.com/sites/eng/_layouts/15/Doc.aspx?sourcedoc=%7B1234%7D&wd=target(Notes.one%7Cabc%2F)';
const NOTES_TOKEN = makeGraphToken({ scp: 'Notes.ReadWrite User.Read', aud: 'https://graph.microsoft.com' });
const FILES_TOKEN = makeGraphToken({ scp: 'Files.ReadWrite.All', aud: 'https://graph.microsoft.com' });

const respond = (status: number, headers?: Record<string, string>): Response => new Response(null, { status, headers });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  page.url = SHAREPOINT_URL;
  clearTokenSources();
});

afterEach(() => {
  clearTokenSources();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnose', () => {
  test('reports the page, every token source, the active source and one Graph probe, matching its output schema', async () => {
    installPreScriptToken(FILES_TOKEN, nowSec() + 3600);
    installMsalToken(NOTES_TOKEN, nowSec() + 7200);
    fetchMock.mockResolvedValueOnce(respond(200, { 'request-id': 'req-42' }));

    const output = await diagnose.handle({});

    expect(diagnose.output.parse(output)).toEqual(output);
    expect(output.pageOrigin).toBe('https://contoso.sharepoint.com');
    expect(output.pageKind).toBe('sharepoint');
    expect(output.isOneNoteTab).toBe(true);
    expect(output.apiBase).toBe('https://graph.microsoft.com/v1.0');
    expect(output.tokenSources.map(s => [s.source, s.present, s.notesScope])).toEqual([
      ['preScriptNamespace', true, false],
      ['localStorageMirror', false, false],
      ['msalPlaintext', true, true],
    ]);
    expect(output.activeSource).toBe('msalPlaintext');
    expect(output.probes).toEqual([
      expect.objectContaining({
        name: 'graph:/me/onenote/notebooks',
        path: '/me/onenote/notebooks',
        status: 200,
        ok: true,
        requestId: 'req-42',
        error: null,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const probeUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(probeUrl.pathname).toBe('/v1.0/me/onenote/notebooks');
    expect(probeUrl.searchParams.get('$top')).toBe('1');
    expect(probeUrl.searchParams.get('$select')).toBe('id');
  });

  test('never exposes a token or the page path and query', async () => {
    installPreScriptToken(FILES_TOKEN, nowSec() + 3600);
    installMsalToken(NOTES_TOKEN);
    fetchMock.mockResolvedValueOnce(respond(200));

    const serialized = JSON.stringify(await diagnose.handle({}));

    expect(serialized).not.toContain(NOTES_TOKEN);
    expect(serialized).not.toContain(FILES_TOKEN);
    expect(serialized).not.toContain('signature');
    expect(serialized).not.toContain('/sites/eng');
    expect(serialized).not.toContain('Doc.aspx');
    expect(serialized).not.toContain('sourcedoc');
    expect(serialized).toContain('https://contoso.sharepoint.com');
  });

  test('resolves with absent sources and a skipped probe when no token exists', async () => {
    const output = await diagnose.handle({});

    expect(diagnose.output.parse(output)).toEqual(output);
    expect(output.tokenSources.every(s => !s.present)).toBe(true);
    expect(output.activeSource).toBeNull();
    expect(output.probes[0]).toMatchObject({ status: null, ok: false, error: 'no Notes-scoped token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('probes exactly once even when Graph answers 500', async () => {
    installMsalToken(NOTES_TOKEN);
    fetchMock.mockImplementation(async () => respond(500, { 'x-proxyerrorlabel': 'Microsoft::Proxy::OnHttpRequest' }));

    const output = await diagnose.handle({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output.probes[0]).toMatchObject({
      status: 500,
      ok: false,
      frontDoor: 'Microsoft::Proxy::OnHttpRequest',
      error: null,
    });
  });

  test('classifies the standalone app as cloud-app and an unparseable URL as other', async () => {
    page.url = 'https://onenote.cloud.microsoft/notebooks/abc';
    expect(await diagnose.handle({})).toMatchObject({
      pageOrigin: 'https://onenote.cloud.microsoft',
      pageKind: 'cloud-app',
      isOneNoteTab: true,
    });

    page.url = 'not a url';
    expect(await diagnose.handle({})).toMatchObject({ pageOrigin: null, pageKind: 'other', isOneNoteTab: false });
  });

  test('reports a page with an opaque origin as pageOrigin null and kind other without throwing', async () => {
    page.url = 'about:blank';
    const output = await diagnose.handle({});
    expect(diagnose.output.parse(output)).toEqual(output);
    expect(output).toMatchObject({ pageOrigin: null, pageKind: 'other', isOneNoteTab: false });
  });
});
