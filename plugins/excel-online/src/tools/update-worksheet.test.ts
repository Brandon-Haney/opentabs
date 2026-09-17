import { describe, expect, test, vi } from 'vitest';
import { updateWorksheet } from './update-worksheet.js';

/**
 * The tool sends one in-session call and reads the worksheet back out of it.
 * The replay policy these tests used to cover belonged to the Graph path, which
 * retried a transient status and had to hold back a rename; the in-session call
 * is issued once, so only what it sends and what it returns matter.
 */
describe('update_worksheet', () => {
  const context = (response: unknown) => ({ reportProgress: () => {}, bridge: vi.fn().mockResolvedValue(response) });

  test('sends only the properties given, and returns the worksheet Excel answered with', async () => {
    const ctx = context({ response: '{"id":"ws","name":"Renamed","position":4,"visibility":"Visible"}' });
    const output = await updateWorksheet.handle({ name: 'Sheet1', new_name: 'Renamed' }, ctx);

    expect(output.worksheet).toEqual({ id: 'ws', name: 'Renamed', position: 4, visibility: 'Visible' });
    const directive = (ctx.bridge.mock.calls[0]?.[0] as { __bridge: { options: { request: Record<string, unknown> } } })
      .__bridge.options.request;
    expect(directive).toMatchObject({
      HttpMethod: 'Patch',
      PathAndQuery: "worksheets('Sheet1')",
      RequestBody: '{"name":"Renamed"}',
    });
  });

  test('reports a worksheet Excel answered nothing for rather than returning an empty result', async () => {
    await expect(
      updateWorksheet.handle({ name: 'Missing', visibility: 'Hidden' }, context({ response: '' })),
    ).rejects.toThrow(/"Missing"/);
  });
});
