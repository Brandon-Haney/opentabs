import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { driveIdInput } from './schemas.js';
import { api, requireDriveId } from '../powerpoint-api.js';

export const deleteItem = defineTool({
  name: 'delete_item',
  displayName: 'Delete File',
  description: 'Permanently delete a file or folder from OneDrive by its item ID. This action cannot be undone.',
  summary: 'Delete a file or folder',
  icon: 'trash-2',
  group: 'Files',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file or folder to delete'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the deletion succeeded'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    await api(`/drives/${driveId}/items/${params.item_id}`, { method: 'DELETE' });
    return { success: true };
  },
});
