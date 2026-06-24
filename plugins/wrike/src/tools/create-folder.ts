import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getAccountId, getCurrentUserId, rpc } from '../wrike-api.js';
import { permalink } from './schemas.js';

interface FolderSaveResponse {
  id?: number | string;
  title?: string;
}

export const createFolder = defineTool({
  name: 'create_folder',
  displayName: 'Create Folder',
  description:
    'Create a new folder inside an existing folder or project. Returns the new folder id and permalink. Use create_task to add tasks to it, or list_folder_contents to inspect it. To create a project (which also carries owners, dates, and a status), a separate project flow is required.',
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
    const data: Record<string, unknown> = {
      accountId: getAccountId(),
      title: params.title,
      parentFoldersAdd: [Number(params.parent_folder_id)],
      // `createFolder` selects the folder code path; `project`/`isSpace` false
      // makes it a plain folder rather than a project or space.
      systemFieldsAdd: { project: false, isSpace: false, pinnedView: 'tableV2' },
      createFolder: true,
    };

    // Share the new folder with the current user so it is visible to them; a
    // folder created inside a shared parent otherwise inherits its sharing.
    const currentUserId = getCurrentUserId();
    if (currentUserId) data.sharedsAdd = [currentUserId];

    const result = await rpc<FolderSaveResponse>('task_save', { data });
    const id = result.id !== undefined && result.id !== null ? String(result.id) : '';
    return { id, title: result.title ?? params.title, permalink: permalink(id) };
  },
});
