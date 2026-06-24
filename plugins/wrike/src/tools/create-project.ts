import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { saveContainer } from '../wrike-api.js';
import { permalink } from './schemas.js';

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description:
    'Create a new project inside an existing folder or project. A project is a folder that also tracks a project status, owners, and dates. Returns the new project id and permalink. Use create_task to add tasks to it, or create_folder for a plain folder.',
  summary: 'Create a project inside another folder or project',
  icon: 'folder-kanban',
  group: 'Folders',
  input: z.object({
    title: z.string().min(1).describe('Project title'),
    parent_folder_id: z.string().describe('Folder or project id to create the new project inside'),
  }),
  output: z.object({
    id: z.string().describe('The new project id'),
    title: z.string().describe('The created project title'),
    permalink: z.string().describe('Permanent URL to open the project in Wrike'),
  }),
  handle: async params => {
    const result = await saveContainer(params.title, Number(params.parent_folder_id), { project: true });
    const id = result.id !== undefined && result.id !== null ? String(result.id) : '';
    return { id, title: result.title ?? params.title, permalink: permalink(id) };
  },
});
