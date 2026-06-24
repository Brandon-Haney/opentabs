import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

export const renameTask = defineTool({
  name: 'rename_task',
  displayName: 'Rename Task',
  description:
    "Change a task's title. To change status, assignees, or dates, use set_task_status, assign_task, or set_task_dates.",
  summary: "Change a task's title",
  icon: 'pencil',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id to rename'),
    title: z.string().min(1).describe('New title'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the title was changed'),
  }),
  handle: async params => {
    await rpc('task_save_title', { taskId: Number(params.task_id), title: params.title });
    return { success: true };
  },
});
