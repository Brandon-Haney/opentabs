import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

export const moveTask = defineTool({
  name: 'move_task',
  displayName: 'Move Task',
  description:
    'Move a task between folders, or add/remove it from folders. Wrike tasks can live in multiple folders at once, so adding and removing are independent. To relocate a task, pass the destination in add_to_folder_ids and its current folder in remove_from_folder_ids (read the current folders from get_task). At least one of add_to_folder_ids or remove_from_folder_ids is required.',
  summary: 'Move a task between folders or change folder membership',
  icon: 'folder-input',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id to move'),
    add_to_folder_ids: z.array(z.string()).optional().describe('Folder or project ids to add the task to'),
    remove_from_folder_ids: z.array(z.string()).optional().describe('Folder or project ids to remove the task from'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the folder membership was updated'),
  }),
  handle: async params => {
    const add = params.add_to_folder_ids ?? [];
    const remove = params.remove_from_folder_ids ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw ToolError.validation('Provide at least one folder id in add_to_folder_ids or remove_from_folder_ids.');
    }

    const data: Record<string, unknown> = { id: Number(params.task_id) };
    if (add.length > 0) data.parentFoldersAdd = add.map(Number);
    if (remove.length > 0) data.parentFoldersRemove = remove.map(Number);

    await rpc('task_save', { data });
    return { success: true };
  },
});
