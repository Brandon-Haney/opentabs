import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { PROP, REF_TYPE } from './schemas.js';
import { editTaskProperty } from '../wrike-api.js';

export const setTaskStatus = defineTool({
  name: 'set_task_status',
  displayName: 'Set Task Status',
  description:
    "Set a task's workflow status. The status_id must belong to the task's workflow — call list_task_statuses first to get valid status ids and titles.",
  summary: "Change a task's workflow status",
  icon: 'circle-check',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id'),
    status_id: z.string().describe('The target status id (from list_task_statuses)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the status was changed'),
  }),
  handle: async params => {
    await editTaskProperty(
      Number(params.task_id),
      { [PROP.STATUS]: { type: 'SetValue', value: { typeId: REF_TYPE.STATUS, id: Number(params.status_id) } } },
      [PROP.STATUS],
    );
    return { success: true };
  },
});
