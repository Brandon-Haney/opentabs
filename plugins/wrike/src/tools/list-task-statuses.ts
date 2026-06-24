import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

interface StatusMenuResponse {
  currentWorkflow?: {
    id?: number | string;
    title?: string;
    statuses?: Array<{
      id?: number | string;
      title?: string;
      group?: string;
      color?: string;
    }>;
  };
  currentStatusId?: number | string;
}

const idStr = (id: number | string | undefined): string => (id !== undefined && id !== null ? String(id) : '');

export const listTaskStatuses = defineTool({
  name: 'list_task_statuses',
  displayName: 'List Task Statuses',
  description:
    "List the workflow statuses available for a task, plus the task's current status. Call this before set_task_status to discover valid status ids and titles. The status group is one of Active, Completed, Deferred, or Cancelled.",
  summary: 'List a task workflow and its statuses',
  icon: 'workflow',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id whose workflow statuses to list'),
  }),
  output: z.object({
    workflow_id: z.string().describe('Id of the workflow applied to this task'),
    workflow_name: z.string().describe('Name of the workflow'),
    current_status_id: z.string().describe("The task's current status id"),
    statuses: z
      .array(
        z.object({
          id: z.string().describe('Status id (pass to set_task_status)'),
          title: z.string().describe('Status title (e.g. Active, Completed, Not Started)'),
          group: z.string().describe('Status group: Active, Completed, Deferred, or Cancelled'),
          color: z.string().describe('Hex color, or empty'),
        }),
      )
      .describe('Statuses available in this task workflow'),
  }),
  handle: async params => {
    const data = await rpc<StatusMenuResponse>('workflow_status_menu_component/get_status_menu_initial_data', {
      taskGroupIds: [Number(params.task_id)],
    });
    const workflow = data.currentWorkflow ?? {};
    return {
      workflow_id: idStr(workflow.id),
      workflow_name: workflow.title ?? '',
      current_status_id: idStr(data.currentStatusId),
      statuses: (workflow.statuses ?? []).map(status => ({
        id: idStr(status.id),
        title: status.title ?? '',
        group: status.group ?? '',
        color: status.color ?? '',
      })),
    };
  },
});
