import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';
import { permalink } from './schemas.js';

interface TaskSaveResponse {
  id?: number | string;
  title?: string;
}

export const createTask = defineTool({
  name: 'create_task',
  displayName: 'Create Task',
  description:
    'Create a new task. Provide a folder_id to create it inside a folder or project, and/or a parent_task_id to create it as a subtask. At least one of folder_id or parent_task_id is required. Returns the new task id and permalink.',
  summary: 'Create a task in a folder or as a subtask',
  icon: 'plus',
  group: 'Tasks',
  input: z.object({
    title: z.string().min(1).describe('Task title'),
    folder_id: z.string().optional().describe('Folder or project id to place the task in'),
    parent_task_id: z.string().optional().describe('Parent task id, to create this as a subtask'),
  }),
  output: z.object({
    id: z.string().describe('The new task id'),
    title: z.string().describe('The created task title'),
    permalink: z.string().describe('Permanent URL to open the task in Wrike'),
  }),
  handle: async params => {
    if (!params.folder_id && !params.parent_task_id) {
      throw ToolError.validation('Provide a folder_id and/or a parent_task_id to create the task under.');
    }

    const data: Record<string, unknown> = {
      title: params.title,
    };
    if (params.folder_id) data.parentFoldersAdd = [Number(params.folder_id)];
    if (params.parent_task_id) data.superTasksAdd = [Number(params.parent_task_id)];

    const result = await rpc<TaskSaveResponse>('task_save', { data });
    const id = result.id !== undefined && result.id !== null ? String(result.id) : '';
    return { id, title: result.title ?? params.title, permalink: permalink(id) };
  },
});
