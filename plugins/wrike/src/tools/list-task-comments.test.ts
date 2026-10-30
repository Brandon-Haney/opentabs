import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as wrikeApi from '../wrike-api.js';
import { listTaskComments } from './list-task-comments.js';

vi.mock('../wrike-api.js', () => ({ rpc: vi.fn() }));

const rpc = vi.mocked(wrikeApi.rpc);
const context: ToolHandlerContext = { reportProgress: vi.fn() };

/** The `changes` the tool reports for one stream entry carrying these updates. */
const changesFor = async (updates: unknown[]): Promise<string[]> => {
  rpc.mockResolvedValue({ entries: [{ id: '1', updates }] });
  const { entries } = await listTaskComments.handle({ task_id: '42' }, context);
  return entries[0]?.changes ?? [];
};

beforeEach(() => {
  rpc.mockReset();
});

describe('list_task_comments changes', () => {
  test('summarizes the update types it knows', async () => {
    expect(
      await changesFor([
        { statusUpdate: { newValue: { title: 'Done' } } },
        { assigneeUpdate: { action: 'Add', newValue: [{ firstName: 'Pat', lastName: 'Doe' }] } },
        { parentsUpdate: { action: 'Remove', newValue: [{ name: 'Backlog' }] } },
        { rescheduleUpdate: { newValue: { startDate: '2026-11-01', finishDate: '2026-11-05' } } },
      ]),
    ).toEqual([
      'Status changed to "Done"',
      'Assignee added: Pat Doe',
      'Removed from folder: Backlog',
      'Dates changed: start 2026-11-01, finish 2026-11-05',
    ]);
  });

  test('reports only the dates a change touched, and tells a clear from no change', async () => {
    expect(
      await changesFor([
        {
          rescheduleUpdate: {
            oldValue: { startDate: '2026-10-30', finishDate: null },
            newValue: { startDate: '2026-11-09', finishDate: null },
          },
        },
        {
          rescheduleUpdate: {
            oldValue: { startDate: '2026-10-30', finishDate: '2026-11-13' },
            newValue: { startDate: '2026-10-30', finishDate: null },
          },
        },
        { rescheduleUpdate: { oldValue: { startDate: null }, newValue: { startDate: null } } },
      ]),
    ).toEqual(['Dates changed: start 2026-11-09', 'Dates changed: start 2026-10-30, finish cleared', 'Dates changed']);
  });

  test('summarizes title and description changes', async () => {
    expect(
      await changesFor([
        { titleUpdate: { action: 'Update', oldValue: 'Old name', newValue: 'New name' } },
        { descriptionUpdate: { action: 'Update', oldValue: null, newValue: 0 } },
      ]),
    ).toEqual(['Title changed from "Old name" to "New name"', 'Description edited']);
  });

  test('names an update type it does not know instead of dropping it', async () => {
    expect(await changesFor([{ customFieldUpdate: { newValue: 'x' } }])).toEqual(['[unsupported: customFieldUpdate]']);
  });

  test('names the keys of an entry that has no update key, and skips an empty one', async () => {
    expect(await changesFor([{ somethingElse: true }, {}])).toEqual(['[unsupported: somethingElse]']);
  });
});

describe('list_task_comments order', () => {
  test('returns entries newest first, whatever order Wrike sends them in', async () => {
    rpc.mockResolvedValue({
      entries: [
        { id: 'old', createdDate: 1_000 },
        { id: 'new', createdDate: 3_000 },
        { id: 'mid', createdDate: 2_000 },
      ],
      hasOlderChanges: true,
    });
    const { entries, has_older } = await listTaskComments.handle({ task_id: '42' }, context);
    expect(entries.map(entry => entry.id)).toEqual(['new', 'mid', 'old']);
    expect(has_older).toBe(true);
  });
});
