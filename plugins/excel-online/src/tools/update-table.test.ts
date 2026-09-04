/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://excel.cloud.microsoft/open/onedrive/?driveId=drive-1&docId=item-1"}
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { updateTable } from './update-table.js';

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const LS_TOKEN_KEY = '__opentabs_excel_graph_token';
const TABLE_URL = "https://graph.microsoft.com/v1.0/drives/drive-1/items/item-1/workbook/tables('Sales')";

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

describe('update_table replay policy', () => {
  test('replays a PATCH that does not rename the table', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(200, { id: 't1', name: 'Sales', style: 'TableStyleMedium9' }));
    const output = await settle(updateTable.handle({ table: 'Sales', style: 'TableStyleMedium9' }));
    expect(output.table.style).toBe('TableStyleMedium9');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe(TABLE_URL);
      expect(call[1]?.method).toBe('PATCH');
      expect(call[1]?.body).toBe('{"style":"TableStyleMedium9"}');
    }
  });

  test('sends a renaming PATCH exactly once on a transient status', async () => {
    fetchMock.mockResolvedValue(respond(503));
    await expect(settle(updateTable.handle({ table: 'Sales', new_name: 'Revenue' }))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"name":"Revenue"}');
  });

  test('rejects an empty update without a request', async () => {
    await expect(updateTable.handle({ table: 'Sales' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
