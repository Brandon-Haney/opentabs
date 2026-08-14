import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput, type GraphCollection, mapPermission, permissionSchema, type RawPermission } from './schemas.js';

export const listPermissions = defineTool({
  name: 'list_permissions',
  displayName: 'List Permissions',
  description:
    'List all permissions and sharing links for a file or folder. Shows who has access and what role they have.',
  summary: 'List sharing permissions for a file',
  icon: 'shield',
  group: 'Sharing',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file or folder'),
  }),
  output: z.object({
    permissions: z.array(permissionSchema).describe('Sharing permissions'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    const data = await api<GraphCollection<RawPermission>>(`/drives/${driveId}/items/${params.item_id}/permissions`);
    return { permissions: (data.value ?? []).map(mapPermission) };
  },
});
