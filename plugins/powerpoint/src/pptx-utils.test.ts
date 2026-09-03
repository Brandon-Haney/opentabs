/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://contoso.sharepoint.com/:p:/r/sites/x/deck.pptx"}
 */
import { log, ToolError } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FILE_LOCKED_MESSAGE, GRAPH_BASE } from './powerpoint-api.js';
import { commitPresentation, downloadPptx, editPresentation, readZip, writeZip } from './pptx-utils.js';
import { clearAllSessions, peekSession, storeSession } from './session.js';

// The SDK freezes `log`, so its methods cannot be spied on; the module mock swaps the object.
vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const DRIVE_ID = 'DRIVE-1';
const ITEM_ID = 'ITEM-1';
const TOKEN = 'graph-token';
const ETAG = '"etag-1"';
const DOWNLOAD_URL = 'https://contoso-my.sharepoint.com/download.aspx?tempauth=SECRET';
const ITEM_URL = `${GRAPH_BASE}/drives/${DRIVE_ID}/items/${ITEM_ID}`;
const PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type OpenTabsGlobal = { __openTabs?: { preScript?: Record<string, Record<string, unknown>> } };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const packageBlob = (): Promise<Blob> =>
  writeZip(new Map([['ppt/slides/slide1.xml', encoder.encode('<p:sld>original</p:sld>')]]));

const respond = (
  status: number,
  headers?: Record<string, string>,
  body: BodyInit | null = `body-${status}`,
): Response => new Response(body, { status, headers });
const metadataResponse = (): Response =>
  new Response(JSON.stringify({ eTag: ETAG, '@microsoft.graph.downloadUrl': DOWNLOAD_URL }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const rejection = async (promise: Promise<unknown>): Promise<ToolError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw new Error(`expected a ToolError, got ${String(error)}`);
  }
  throw new Error('expected the promise to reject');
};

type FetchCall = { url: string; init: RequestInit | undefined };
const calls = (): FetchCall[] => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
const putCalls = (): FetchCall[] => calls().filter(c => c.init?.method === 'PUT');
const headerOf = (call: FetchCall, name: string): string | undefined =>
  (call.init?.headers as Record<string, string> | undefined)?.[name];

/**
 * Routes the three request shapes `editPresentation` makes: item metadata GET,
 * download GET, and content PUT. `onPut` answers the PUTs in order.
 */
const routeFetch = (onPut: Array<() => Response>, onMetadata: Array<() => Response> = []): void => {
  let putIndex = 0;
  let metadataIndex = 0;
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'PUT') {
      const next = onPut[putIndex++];
      if (!next) throw new Error('unexpected PUT');
      return next();
    }
    // Node's Response accepts an ArrayBuffer body; the jsdom Blob writeZip returns is a foreign class to it.
    if (url === DOWNLOAD_URL) return new Response(await (await packageBlob()).arrayBuffer(), { status: 200 });
    if (url === ITEM_URL) {
      const scripted = onMetadata[metadataIndex++];
      return scripted ? scripted() : metadataResponse();
    }
    throw new Error(`unexpected request to ${new URL(url).host}`);
  });
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  clearAllSessions();
  vi.mocked(log.warn).mockClear();
  (globalThis as OpenTabsGlobal).__openTabs = {
    preScript: { powerpoint: { graph: { token: TOKEN, exp: Math.floor(Date.now() / 1000) + 3600 } } },
  };
});

afterEach(() => {
  delete (globalThis as OpenTabsGlobal).__openTabs;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editPresentation — guarded save', () => {
  test('reads, mutates and saves once with the observed eTag as the precondition', async () => {
    routeFetch([() => respond(200, undefined, '{}')]);
    const result = await editPresentation(ITEM_ID, DRIVE_ID, entries => {
      entries.set('ppt/slides/slide1.xml', encoder.encode('<p:sld>edited</p:sld>'));
      return 'done';
    });
    expect(result).toBe('done');
    const [put] = putCalls();
    expect(putCalls()).toHaveLength(1);
    expect(put?.url).toBe(`${ITEM_URL}/content`);
    expect(headerOf(put as FetchCall, 'If-Match')).toBe(ETAG);
    expect(headerOf(put as FetchCall, 'Content-Type')).toBe(PPTX_CONTENT_TYPE);
    expect(headerOf(put as FetchCall, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(put?.init?.credentials).toBe('omit');
    const saved = await readZip(put?.init?.body as Blob);
    expect(decoder.decode(saved.get('ppt/slides/slide1.xml'))).toBe('<p:sld>edited</p:sld>');
  });

  test('never replays the PUT on a transient failure and says the outcome is unknown', async () => {
    routeFetch([() => respond(500, { 'request-id': 'req-save' })]);
    const mutate = vi.fn();
    const error = await rejection(editPresentation(ITEM_ID, DRIVE_ID, mutate));
    expect(putCalls()).toHaveLength(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.category).toBe('internal');
    expect(error.message).toContain('after 1 attempt');
    expect(error.message).toContain('request-id req-save');
    expect(error.message).toContain('may or may not have been applied');
    expect(error.message).toContain('get_slides');
    expect(error.message).not.toContain(ITEM_ID);
  });

  test('replays the PUT only when the front door refused it before forwarding', async () => {
    routeFetch([
      () => respond(500, { 'x-proxyerrorlabel': 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest' }),
      () => respond(200, undefined, '{}'),
    ]);
    const mutate = vi.fn();
    await editPresentation(ITEM_ID, DRIVE_ID, mutate);
    expect(putCalls()).toHaveLength(2);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  test('reports every front-door-refused replay of the PUT in the attempt count', async () => {
    const refused = () =>
      respond(500, { 'x-proxyerrorlabel': 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest' });
    routeFetch([refused, refused, refused]);
    const mutate = vi.fn();
    const error = await rejection(editPresentation(ITEM_ID, DRIVE_ID, mutate));
    expect(putCalls()).toHaveLength(3);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('after 3 attempts');
    expect(error.message).toContain('may or may not have been applied');
  });

  test('adds the unknown-outcome hint to a network failure of the save', async () => {
    routeFetch([
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]);
    const error = await rejection(editPresentation(ITEM_ID, DRIVE_ID, () => undefined));
    expect(putCalls()).toHaveLength(1);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('may or may not have been applied');
  });

  test('re-reads and re-applies the edit when the precondition fails, then succeeds', async () => {
    routeFetch([() => respond(412, undefined, null), () => respond(200, undefined, '{}')]);
    const mutate = vi.fn();
    await editPresentation(ITEM_ID, DRIVE_ID, mutate);
    expect(putCalls()).toHaveLength(2);
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  test('explains the co-authoring lock on 423 without the unknown-outcome hint', async () => {
    routeFetch([() => respond(423)]);
    const error = await rejection(editPresentation(ITEM_ID, DRIVE_ID, () => undefined));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe(FILE_LOCKED_MESSAGE);
  });

  test('with a session open, a failing edit touches no network and rolls the package back', async () => {
    const original = encoder.encode('<p:sld>original</p:sld>');
    storeSession({
      driveId: DRIVE_ID,
      itemId: ITEM_ID,
      entries: new Map([['ppt/slides/slide1.xml', original]]),
      etag: ETAG,
      openedAt: Date.now(),
      lastAccessedAt: Date.now(),
      dirty: false,
    });
    await expect(
      editPresentation(ITEM_ID, DRIVE_ID, entries => {
        entries.set('ppt/slides/slide1.xml', encoder.encode('half'));
        throw ToolError.validation('bad edit');
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
    const session = peekSession(DRIVE_ID, ITEM_ID);
    expect(session?.dirty).toBe(false);
    expect(session?.entries.get('ppt/slides/slide1.xml')).toBe(original);
  });
});

describe('downloadPptx — package reads', () => {
  test('retries the metadata GET on 502 and downloads without a bearer header or cookies', async () => {
    routeFetch([], [() => respond(502), () => metadataResponse()]);
    const entries = await downloadPptx(ITEM_ID, DRIVE_ID);
    expect(decoder.decode(entries.get('ppt/slides/slide1.xml'))).toBe('<p:sld>original</p:sld>');
    const metadataCalls = calls().filter(c => c.url === ITEM_URL);
    expect(metadataCalls).toHaveLength(2);
    for (const call of metadataCalls) expect(headerOf(call, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    const [download] = calls().filter(c => c.url === DOWNLOAD_URL);
    expect(download?.init?.headers).toBeUndefined();
    expect(download?.init?.credentials).toBe('omit');
  });

  test('surfaces a metadata failure with the request-id and no item path', async () => {
    routeFetch([], [() => respond(404, { 'request-id': 'req-meta' })]);
    const error = await rejection(downloadPptx(ITEM_ID, DRIVE_ID));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('request-id req-meta');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('commitPresentation — session save', () => {
  test('keeps the session with its edits when the single PUT fails transiently', async () => {
    const edited = encoder.encode('<p:sld>edited</p:sld>');
    storeSession({
      driveId: DRIVE_ID,
      itemId: ITEM_ID,
      entries: new Map([['ppt/slides/slide1.xml', edited]]),
      etag: ETAG,
      openedAt: Date.now(),
      lastAccessedAt: Date.now(),
      dirty: true,
    });
    routeFetch([() => respond(503)]);
    const error = await rejection(commitPresentation(ITEM_ID, DRIVE_ID));
    expect(putCalls()).toHaveLength(1);
    expect(headerOf(putCalls()[0] as FetchCall, 'If-Match')).toBe(ETAG);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('may or may not have been applied');
    const session = peekSession(DRIVE_ID, ITEM_ID);
    expect(session?.dirty).toBe(true);
    expect(session?.entries.get('ppt/slides/slide1.xml')).toBe(edited);
  });
});
