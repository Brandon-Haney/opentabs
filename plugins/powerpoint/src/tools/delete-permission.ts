import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput } from './schemas.js';

export const deletePermission = defineTool({
  name: 'delete_permission',
  displayName: 'Remove Permission',
  description: 'Remove a sharing permission or revoke a sharing link from a file or folder.',
  summary: 'Remove a sharing permission',
  icon: 'shield-x',
  group: 'Sharing',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file or folder'),
    permission_id: z.string().describe('Permission ID to remove (from list_permissions)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the permission was removed'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    await api(`/drives/${driveId}/items/${params.item_id}/permissions/${params.permission_id}`, {
      method: 'DELETE',
    });
    return { success: true };
  },
});
