import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

interface FolderTreeNode {
  id?: number | string;
  t?: string;
  has_c?: boolean;
}

interface FolderTreeResponse {
  folders?: Record<string, FolderTreeNode[] | undefined>;
}

const ROOT_KEY = '-1';

export const listRootFolders = defineTool({
  name: 'list_root_folders',
  displayName: 'List Root Folders',
  description:
    'List the top-level folders, projects, and spaces at the root of the Wrike browse tree. This is the entry point for navigation when no folder id is known yet — take an id from here and pass it to list_folder_contents to drill in, or get_task for details.',
  summary: 'List top-level folders and spaces',
  icon: 'list-tree',
  group: 'Folders',
  input: z.object({}),
  output: z.object({
    folders: z
      .array(
        z.object({
          id: z.string().describe('Folder/project/space id'),
          title: z.string().describe('Display title'),
          has_children: z.boolean().describe('Whether this node contains sub-items'),
        }),
      )
      .describe('Top-level browse-tree nodes'),
    count: z.number().int().describe('Number of nodes returned'),
  }),
  handle: async () => {
    // Omit selectedFolderId — the endpoint rejects non-positive ids, and the
    // root listing does not need a selected node.
    const data = await rpc<FolderTreeResponse>('folder_tree_view_get_initial_data', {
      contextFolderId: ROOT_KEY,
    });

    const roots = data.folders?.[ROOT_KEY] ?? [];
    const folders = roots.map(node => ({
      id: node.id !== undefined && node.id !== null ? String(node.id) : '',
      title: node.t ?? '',
      has_children: node.has_c ?? false,
    }));

    return { folders, count: folders.length };
  },
});
