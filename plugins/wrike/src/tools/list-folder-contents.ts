import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';
import { buildRelatedIndex, mapWorkItem, type RawEntity, type RawRelatedEntity, workItemSchema } from './schemas.js';

// Columns requested from the table endpoint, by stable property id:
// -1 name, -2 assignees, -4 status, -5 location/parents, -6 start, -7 due,
// -8 duration, -10 importance, -31 item type.
const COLUMN_IDS = ['-1', '-2', '-4', '-5', '-6', '-7', '-8', '-10', '-31'];

interface TableResponse {
  entities?: RawEntity[];
  relatedEntities?: RawRelatedEntity[];
}

export const listFolderContents = defineTool({
  name: 'list_folder_contents',
  displayName: 'List Folder Contents',
  description:
    'List the tasks, sub-folders, and projects inside a Wrike folder or project. Returns each item with its title, type, workflow status, assignees, dates, and parent ids. By default includes the full subtree (descendants and subtasks); set include_descendants to false to return only direct children. Use the item ids with get_task or to recurse with list_folder_contents.',
  summary: 'List tasks, folders, and projects in a folder',
  icon: 'folder-open',
  group: 'Folders',
  input: z.object({
    folder_id: z.string().describe('The folder or project id to list contents of (numeric Wrike id)'),
    include_descendants: z
      .boolean()
      .optional()
      .describe('Include nested descendants and subtasks (default true). Set false for direct children only.'),
  }),
  output: z.object({
    items: z.array(workItemSchema).describe('Work items contained in the folder'),
    count: z.number().int().describe('Number of items returned'),
  }),
  handle: async params => {
    const includeDescendants = params.include_descendants ?? true;
    const data = await rpc<TableResponse>('tablet_v2/load_initial_data', {
      rootIds: [params.folder_id],
      columnIds: COLUMN_IDS,
      strategy: {
        showTotalEntities: false,
        showSubtasks: includeDescendants,
        showDescendants: includeDescendants,
        isHierarchical: true,
        expandToProjects: false,
        excludeTasks: false,
        excludeProjects: false,
        entityTypeIds: [-13, -12, -14],
        showGhosts: false,
      },
      sorting: 'Priority',
      snapshotIds: null,
      useUniversalFilters: true,
    });

    const index = buildRelatedIndex(data.relatedEntities);
    // The endpoint always returns the full subtree plus the root itself. Drop
    // the root, then (when descendants aren't wanted) keep only items whose
    // direct parent is the requested folder — the server ignores the strategy
    // flags, so the depth filter is applied here.
    let items = (data.entities ?? [])
      .filter(entity => String(entity.entityId ?? '') !== params.folder_id)
      .map(entity => mapWorkItem(entity, index));

    if (!includeDescendants) {
      items = items.filter(item => item.parent_ids.includes(params.folder_id));
    }

    return { items, count: items.length };
  },
});
