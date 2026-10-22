import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput } from './schemas.js';

export const deletePermission = defineTool({
  name: 'delete_permission',
  displayName: 'Remove Permission',
  description:
    'Remove the access of a person or group to a file or folder, or revoke a sharing link so it stops working ' +
    'for everyone on it. Take the permission id from list_permissions. To take only some people off a link ' +
    'shared with several, use remove_from_link. Inherited permissions must be removed on the folder or site ' +
    'they come from.',
  summary: 'Remove access or revoke a sharing link',
  icon: 'shield-x',
  group: 'Sharing',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file or folder'),
    permission_id: z.string().min(1).describe('Permission ID from list_permissions'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the permission was removed'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    await api(`/drives/${driveId}/items/${params.item_id}/permissions/${encodeURIComponent(params.permission_id)}`, {
      method: 'DELETE',
    });
    return { success: true };
  },
});
