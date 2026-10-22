import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, workbookItemPath } from '../excel-api.js';

export const deletePermission = defineTool({
  name: 'delete_permission',
  displayName: 'Remove Permission',
  description:
    'Remove the access of a person or group to the workbook open in the tab, or revoke a sharing link so it stops ' +
    'working for everyone on it. Take the permission id from list_permissions. To take only some people off a ' +
    'link shared with several, use remove_from_link. Inherited permissions must be removed on the folder or site ' +
    'they come from.',
  summary: 'Remove access or revoke a sharing link',
  icon: 'shield-x',
  group: 'Sharing',
  input: z.object({
    permission_id: z.string().min(1).describe('Permission ID from list_permissions'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the permission was removed'),
  }),
  handle: async params => {
    await api(`${await workbookItemPath()}/permissions/${encodeURIComponent(params.permission_id)}`, {
      method: 'DELETE',
    });
    return { success: true };
  },
});
