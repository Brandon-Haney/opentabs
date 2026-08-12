import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';

/** Each earning task reports the same progress shape; unearned tasks come back null. */
interface RawTaskProgress {
  current?: number;
  obtain?: number;
  limit?: number;
  isFinished?: boolean;
}

interface RawPointsProgress {
  totalPoint?: number;
  totalRegularPoint?: number;
  totalExclusivePoint?: number;
  [task: string]: RawTaskProgress | number | null | undefined;
}

/** Keys in the progress document that are balances rather than tasks. */
const BALANCE_KEYS = new Set(['totalPoint', 'totalRegularPoint', 'totalExclusivePoint']);

export const getPointsProgress = defineTool({
  name: 'get_points_progress',
  displayName: 'Get Points Task Progress',
  description:
    "Get progress against MakerWorld's point-earning tasks — onboarding tasks, per-model and per-profile reward caps, and any active limited-time offers. Shows which tasks are complete and which still have points available, and reveals the ceilings that cap how fast a balance can grow. Tasks the account is not eligible for are omitted.",
  summary: 'Progress and caps for point-earning tasks',
  icon: 'target',
  group: 'Points',
  input: z.object({}),
  output: z.object({
    total_points: z.number().describe('Total point balance'),
    regular_points: z.number().describe('Regular point balance'),
    exclusive_points: z.number().describe('Exclusive point balance'),
    tasks: z
      .array(
        z.object({
          name: z.string().describe('Task identifier'),
          current: z.number().describe('Points earned so far from this task'),
          limit: z.number().describe('Maximum points this task can award, 0 when uncapped'),
          is_finished: z.boolean().describe('Whether the task is complete'),
        }),
      )
      .describe('Point-earning tasks the account is eligible for'),
  }),
  handle: async () => {
    const data = await api<RawPointsProgress>('point-service', '/point-bill/progress');

    // The document mixes tasks with balances and with nested helper arrays such as
    // progress item lists. `isFinished` is the marker every real task carries.
    const tasks = Object.entries(data)
      .filter(
        (entry): entry is [string, RawTaskProgress] =>
          !BALANCE_KEYS.has(entry[0]) &&
          typeof entry[1] === 'object' &&
          entry[1] !== null &&
          !Array.isArray(entry[1]) &&
          'isFinished' in entry[1],
      )
      .map(([name, task]) => ({
        name,
        current: task.current ?? task.obtain ?? 0,
        limit: task.limit ?? 0,
        is_finished: task.isFinished ?? false,
      }));

    return {
      total_points: data.totalPoint ?? 0,
      regular_points: data.totalRegularPoint ?? 0,
      exclusive_points: data.totalExclusivePoint ?? 0,
      tasks,
    };
  },
});
