import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';
import { buildRelatedIndex, mapWorkItem, type RawEntity, type RawRelatedEntity, workItemSchema } from './schemas.js';

// Columns requested for each deleted item, by stable property id:
// -1 name, -2 assignees, -4 status, -5 location/parents, -6 start, -7 due,
// -10 importance, -14 created, -31 item type.
const COLUMN_IDS = ['-1', '-2', '-4', '-5', '-6', '-7', '-10', '-14', '-31'];

interface RecycleBinResponse {
  entities?: RawEntity[];
  relatedEntities?: RawRelatedEntity[];
}

const numericId = (entity: RawEntity): number => Number(entity.entityId ?? 0);

export const listRecycleBin = defineTool({
  name: 'list_recycle_bin',
  displayName: 'List Recycle Bin',
  description:
    'List tasks, folders, and projects in the Wrike Recycle Bin (soft-deleted items that can be restored). Each item includes its title, type, and the parent ids it was deleted from. Items are returned most-recent first; pass a limit to cap the number returned (default 100). Use an item id with restore_from_recycle_bin to bring it back.',
  summary: 'List soft-deleted items in the Recycle Bin',
  icon: 'trash',
  group: 'Folders',
  input: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of items to return, most-recent first (default 100).'),
  }),
  output: z.object({
    items: z.array(workItemSchema).describe('Deleted items in the Recycle Bin, most-recent first'),
    count: z.number().int().describe('Number of items returned'),
    total: z.number().int().describe('Total number of items in the Recycle Bin'),
  }),
  handle: async params => {
    const limit = params.limit ?? 100;
    const data = await rpc<RecycleBinResponse>('smart_folder_load_initial_data', {
      rootIds: ['-1'],
      columnIds: COLUMN_IDS,
      strategy: {
        showTotalEntities: false,
        showSubtasks: true,
        showDescendants: true,
        isHierarchical: true,
        expandToProjects: false,
        excludeTasks: false,
        excludeProjects: false,
        entityTypeIds: [-11, -13, -12],
        showGhosts: false,
      },
      sorting: 'Priority',
      useUniversalFilters: true,
      recycleBin: true,
      limit: 1000,
      viewType: 'recycle-bin',
    });

    const index = buildRelatedIndex(data.relatedEntities);
    // The endpoint does not expose a deletion timestamp, so order by numeric id
    // descending: Wrike ids increase over time, so the most recently created
    // items — which include anything just deleted — surface first.
    const ordered = [...(data.entities ?? [])].sort((a, b) => numericId(b) - numericId(a));
    const items = ordered.slice(0, limit).map(entity => mapWorkItem(entity, index));

    return { items, count: items.length, total: ordered.length };
  },
});
