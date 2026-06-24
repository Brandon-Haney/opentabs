import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';
import {
  buildRelatedIndex,
  mapWorkItem,
  type RawEntity,
  type RawRelatedEntity,
  type RelatedIndex,
  workItemSchema,
} from './schemas.js';

// Columns requested from the table endpoint, by stable property id:
// -1 name, -2 assignees, -4 status, -5 location/parents, -6 start, -7 due,
// -8 duration, -10 importance, -31 item type.
const COLUMN_IDS = ['-1', '-2', '-4', '-5', '-6', '-7', '-8', '-10', '-31'];

// One node of the table's ordered hierarchy. `childrenIds` lists a node's
// children in the exact order the table renders them, and `parentIds` gives the
// item's placement in the tree — together they reproduce the on-screen order
// and nesting, which the flat `entities` array (returned in creation order)
// does not.
interface ItemStructureNode {
  id?: number | string;
  childrenIds?: Array<number | string>;
  parentIds?: Array<number | string>;
}

interface TableResponse {
  entities?: RawEntity[];
  relatedEntities?: RawRelatedEntity[];
  itemStructure?: ItemStructureNode[];
}

type WorkItem = z.infer<typeof workItemSchema>;

/**
 * Emits the folder's items in the order the table view renders them by walking
 * `itemStructure` depth-first from the requested folder. Each item's parent ids
 * are taken from the tree node so they reflect the item's placement in this
 * listing. Returns null when the structure is missing, so the caller can fall
 * back to the raw entity order.
 */
const orderByStructure = (
  structure: ItemStructureNode[] | undefined,
  entityById: Map<string, RawEntity>,
  index: RelatedIndex,
  rootId: string,
  includeDescendants: boolean,
): WorkItem[] | null => {
  const nodeById = new Map<string, ItemStructureNode>();
  for (const node of structure ?? []) {
    if (node.id !== undefined && node.id !== null) nodeById.set(String(node.id), node);
  }
  if (!nodeById.has(rootId)) return null;

  const items: WorkItem[] = [];
  const visited = new Set<string>();

  const visitChildren = (parentId: string): void => {
    for (const childId of nodeById.get(parentId)?.childrenIds ?? []) {
      const id = String(childId);
      if (visited.has(id)) continue;
      visited.add(id);

      const entity = entityById.get(id);
      if (entity) {
        const parentIds = (nodeById.get(id)?.parentIds ?? []).map(String);
        const item = mapWorkItem(entity, index);
        items.push(parentIds.length > 0 ? { ...item, parent_ids: parentIds } : item);
      }

      if (includeDescendants) visitChildren(id);
    }
  };

  visitChildren(rootId);
  return items;
};

/** Raw entity order (creation order) — used when the tree structure is absent. */
const fallbackOrder = (
  entities: RawEntity[] | undefined,
  index: RelatedIndex,
  rootId: string,
  includeDescendants: boolean,
): WorkItem[] => {
  let items = (entities ?? [])
    .filter(entity => String(entity.entityId ?? '') !== rootId)
    .map(entity => mapWorkItem(entity, index));
  if (!includeDescendants) {
    items = items.filter(item => item.parent_ids.includes(rootId));
  }
  return items;
};

export const listFolderContents = defineTool({
  name: 'list_folder_contents',
  displayName: 'List Folder Contents',
  description:
    'List the tasks, sub-folders, and projects inside a Wrike folder or project, in the same order the table view shows them. Returns each item with its title, type, workflow status, assignees, dates, and parent ids. By default includes the full subtree (descendants and subtasks); set include_descendants to false to return only direct children. Use the item ids with get_task or to recurse with list_folder_contents.',
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
    items: z.array(workItemSchema).describe('Work items contained in the folder, in table-view display order'),
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
    const entityById = new Map<string, RawEntity>();
    for (const entity of data.entities ?? []) {
      if (entity.entityId !== undefined && entity.entityId !== null) {
        entityById.set(String(entity.entityId), entity);
      }
    }

    // The endpoint returns the full subtree plus the root itself, with the
    // display order encoded in `itemStructure`. Walk that tree to mirror the
    // table view; fall back to raw entity order if it is ever unavailable.
    const items =
      orderByStructure(data.itemStructure, entityById, index, params.folder_id, includeDescendants) ??
      fallbackOrder(data.entities, index, params.folder_id, includeDescendants);

    return { items, count: items.length };
  },
});
