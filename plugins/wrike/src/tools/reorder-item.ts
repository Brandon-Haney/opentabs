import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

// The reorder endpoint is a batch call: each entry positions one item relative
// to a sibling `anchorId`. The outer `{ success, data }` envelope is unwrapped
// by rpc(); the per-entry result is nested one level deeper under `response`.
interface BatchPositionResponse {
  entries?: Array<{
    request?: { id?: string; anchorId?: string; move?: string };
    response?: { success?: boolean };
  }>;
}

export const reorderItem = defineTool({
  name: 'reorder_item',
  displayName: 'Reorder Item',
  description:
    'Change the display order of a folder, project, or task by moving it before or after a sibling in the same parent. The item and the anchor must share the same parent — reordering only rearranges siblings; it does not change which folder an item belongs to (use move_task for that). Read the current order from list_folder_contents and pick an anchor_id from the same list. To place an item first, anchor it before the current first item; to place it last, anchor it after the current last item.',
  summary: 'Reorder a sibling item before or after another',
  icon: 'arrow-up-down',
  group: 'Folders',
  input: z.object({
    item_id: z.string().describe('The folder, project, or task id to move'),
    anchor_id: z.string().describe('The sibling id to position relative to (must share the same parent)'),
    position: z
      .enum(['before', 'after'])
      .default('after')
      .describe('Place the item immediately before or after the anchor'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the item was repositioned'),
  }),
  handle: async params => {
    if (params.item_id === params.anchor_id) {
      throw ToolError.validation('item_id and anchor_id must be different items.');
    }

    const result = await rpc<BatchPositionResponse>('tablet_v2/batch_change_item_position', {
      entries: [{ id: params.item_id, anchorId: params.anchor_id, move: params.position }],
    });

    const entry = result.entries?.[0]?.response;
    if (entry?.success !== true) {
      throw ToolError.internal(
        'Wrike rejected the reorder — confirm both ids are siblings in the same parent and are visible in the current view.',
      );
    }
    return { success: true };
  },
});
