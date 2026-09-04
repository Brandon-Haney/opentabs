/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://excel.cloud.microsoft/open/onedrive/?driveId=drive-1&docId=item-1"}
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { updateWorksheet } from './update-worksheet.js';

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const LS_TOKEN_KEY = '__opentabs_excel_graph_token';
const WORKSHEET_URL = "https://graph.microsoft.com/v1.0/drives/drive-1/items/item-1/workbook/worksheets('Sheet1')";

const respond = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { 'content-type': 'application/json' },
  });

/** Resolves `promise` while draining the retry sleeps scheduled under fake timers. */
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  const outcome = promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if (result.ok) return result.value;
  throw result.error;
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token: 'tok', exp: Math.floor(Date.now() / 1000) + 3600 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('update_worksheet replay policy', () => {
  test('replays a PATCH that does not rename the worksheet', async () => {
    fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(200, { id: 'ws', name: 'Sheet1' }));
    const output = await settle(updateWorksheet.handle({ name: 'Sheet1', visibility: 'Hidden' }));
    expect(output.worksheet.name).toBe('Sheet1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe(WORKSHEET_URL);
      expect(call[1]?.method).toBe('PATCH');
      expect(call[1]?.body).toBe('{"visibility":"Hidden"}');
    }
  });

  test('sends a renaming PATCH exactly once on a transient status', async () => {
    fetchMock.mockResolvedValue(respond(503));
    await expect(settle(updateWorksheet.handle({ name: 'Sheet1', new_name: 'Renamed' }))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"name":"Renamed"}');
  });
});
