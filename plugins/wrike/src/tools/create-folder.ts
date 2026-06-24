import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { saveContainer } from '../wrike-api.js';
import { permalink } from './schemas.js';

export const createFolder = defineTool({
  name: 'create_folder',
  displayName: 'Create Folder',
  description:
    'Create a new folder inside an existing folder or project. Returns the new folder id and permalink. Use create_task to add tasks to it, or list_folder_contents to inspect it. To create a project (which tracks owners, dates, and a status) use create_project instead.',
  summary: 'Create a folder inside another folder or project',
  icon: 'folder-plus',
  group: 'Folders',
  input: z.object({
    title: z.string().min(1).describe('Folder title'),
    parent_folder_id: z.string().describe('Folder or project id to create the new folder inside'),
  }),
  output: z.object({
    id: z.string().describe('The new folder id'),
    title: z.string().describe('The created folder title'),
    permalink: z.string().describe('Permanent URL to open the folder in Wrike'),
  }),
  handle: async params => {
    const result = await saveContainer(params.title, Number(params.parent_folder_id), { project: false });
    const id = result.id !== undefined && result.id !== null ? String(result.id) : '';
    return { id, title: result.title ?? params.title, permalink: permalink(id) };
  },
});
