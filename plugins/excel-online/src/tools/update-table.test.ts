import { describe, expect, test, vi } from 'vitest';
import { updateTable } from './update-table.js';

/**
 * The tool sends one in-session call and reads the table back out of it. The
 * replay policy these tests used to cover belonged to the Graph path, which
 * retried a transient status and had to hold back a rename; the in-session call
 * is issued once, so only what it sends and what it returns matter.
 */
describe('update_table', () => {
  const context = (response: unknown) => ({ reportProgress: () => {}, bridge: vi.fn().mockResolvedValue(response) });

  test('sends only the properties given, and returns the table Excel answered with', async () => {
    const ctx = context({ response: '{"id":"t1","name":"Sales","style":"TableStyleMedium9"}' });
    const output = await updateTable.handle({ table: 'Sales', style: 'TableStyleMedium9' }, ctx);

    expect(output.table.style).toBe('TableStyleMedium9');
    const request = (ctx.bridge.mock.calls[0]?.[0] as { __bridge: { options: { request: Record<string, unknown> } } })
      .__bridge.options.request;
    expect(request).toMatchObject({
      HttpMethod: 'Patch',
      PathAndQuery: "tables('Sales')",
      RequestBody: '{"style":"TableStyleMedium9"}',
    });
  });

  test('refuses a call that would change nothing', async () => {
    await expect(updateTable.handle({ table: 'Sales' }, context({ response: '{}' }))).rejects.toThrow(
      /at least one property/,
    );
  });
});
