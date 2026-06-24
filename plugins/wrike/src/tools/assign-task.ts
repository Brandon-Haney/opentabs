import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { PROP, REF_TYPE } from './schemas.js';
import { editTaskProperty } from '../wrike-api.js';

export const assignTask = defineTool({
  name: 'assign_task',
  displayName: 'Assign Task',
  description:
    'Add or remove assignees on a task. Pass contact ids (from list_contacts or get_current_user) in add_assignee_ids and/or remove_assignee_ids. At least one of the two must be provided.',
  summary: 'Add or remove task assignees',
  icon: 'user-plus',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id'),
    add_assignee_ids: z.array(z.string()).optional().describe('Contact ids to add as assignees'),
    remove_assignee_ids: z.array(z.string()).optional().describe('Contact ids to remove as assignees'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the assignees were updated'),
  }),
  handle: async params => {
    const add = params.add_assignee_ids ?? [];
    const remove = params.remove_assignee_ids ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw ToolError.validation('Provide at least one contact id in add_assignee_ids or remove_assignee_ids.');
    }

    await editTaskProperty(
      Number(params.task_id),
      {
        [PROP.ASSIGNEES]: {
          type: 'UpdateCollection',
          valuesAdd: add.map(id => ({ typeId: REF_TYPE.CONTACT, id })),
          valuesRemove: remove.map(id => ({ typeId: REF_TYPE.CONTACT, id })),
        },
      },
      [PROP.ASSIGNEES],
    );
    return { success: true };
  },
});
