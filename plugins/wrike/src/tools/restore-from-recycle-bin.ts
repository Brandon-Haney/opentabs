import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

interface RestoreResponse {
  affectedList?: Array<{ entityId?: number | string; id?: number | string }>;
}

export const restoreFromRecycleBin = defineTool({
  name: 'restore_from_recycle_bin',
  displayName: 'Restore from Recycle Bin',
  description:
    'Restore one or more soft-deleted items (tasks, folders, or projects) from the Recycle Bin back to their original location. Call list_recycle_bin first to find the ids of deleted items. Restoring a folder or project also restores the items that were deleted along with it.',
  summary: 'Restore deleted items from the Recycle Bin',
  icon: 'archive-restore',
  group: 'Folders',
  input: z.object({
    item_ids: z.array(z.string()).min(1).describe('The ids of the deleted tasks, folders, or projects to restore'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the items were restored'),
    restored_ids: z.array(z.string()).describe('The ids that were restored'),
    count: z.number().int().describe('Number of items restored'),
  }),
  handle: async params => {
    const taskIds = params.item_ids.map(id => {
      const numeric = Number(id);
      if (!Number.isFinite(numeric)) throw ToolError.validation(`Invalid item id: "${id}"`);
      return numeric;
    });

    const data = await rpc<RestoreResponse>('recyclebin_restore', { taskIds });

    const restoredIds = (data.affectedList ?? [])
      .map(item => item.entityId ?? item.id)
      .filter((id): id is number | string => id !== undefined && id !== null)
      .map(String);

    return {
      success: true,
      restored_ids: restoredIds.length > 0 ? restoredIds : params.item_ids,
      count: restoredIds.length > 0 ? restoredIds.length : params.item_ids.length,
    };
  },
});
