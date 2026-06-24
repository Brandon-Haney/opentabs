import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

export const deleteTask = defineTool({
  name: 'delete_task',
  displayName: 'Delete Task',
  description:
    'Move a task to the Recycle Bin. This is a soft delete — the task can be restored from the Recycle Bin in Wrike. Subtasks are deleted along with it.',
  summary: 'Move a task to the Recycle Bin',
  icon: 'trash-2',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id to delete'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the task was moved to the Recycle Bin'),
  }),
  handle: async params => {
    await rpc('recyclebin_delete', { taskIds: [Number(params.task_id)] });
    return { success: true };
  },
});
