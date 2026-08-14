import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import {
  DRIVE_ITEM_SELECT,
  driveIdInput,
  driveItemSchema,
  type GraphCollection,
  mapDriveItem,
  type RawDriveItem,
} from './schemas.js';

export const listChildren = defineTool({
  name: 'list_children',
  displayName: 'List Folder Contents',
  description:
    'List files and folders in a OneDrive folder. Defaults to the root folder. Returns file name, size, type, and modification info.',
  summary: 'List files and folders in a directory',
  icon: 'folder-open',
  group: 'Files',
  input: z.object({
    drive_id: driveIdInput,
    folder_id: z.string().optional().describe('Folder item ID — defaults to root'),
    top: z.number().int().min(1).max(200).optional().describe('Max items to return (default 20, max 200)'),
  }),
  output: z.object({
    items: z.array(driveItemSchema).describe('Files and folders'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    const base = params.folder_id
      ? `/drives/${driveId}/items/${params.folder_id}/children`
      : `/drives/${driveId}/root/children`;

    const data = await api<GraphCollection<RawDriveItem>>(base, {
      query: {
        $top: params.top ?? 20,
        $select: DRIVE_ITEM_SELECT,
      },
    });
    return { items: (data.value ?? []).map(mapDriveItem) };
  },
});
