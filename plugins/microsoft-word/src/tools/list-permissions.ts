import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../microsoft-word-api.js';
import { mapPermission, permissionSchema, type RawPermission } from './schemas.js';

export const listPermissions = defineTool({
  name: 'list_permissions',
  displayName: 'List Permissions',
  description:
    'List who can open a file or folder: every sharing link (with its scope) and every person or group granted ' +
    'access directly, with their role. Inherited entries come from a parent folder or the site and cannot be ' +
    'changed on the item itself.',
  summary: 'List who has access to a file or folder',
  icon: 'shield',
  group: 'Sharing',
  input: z.object({
    item_id: z.string().describe('File or folder ID'),
  }),
  output: z.object({
    permissions: z.array(permissionSchema).describe('Sharing links and direct grants on the item'),
  }),
  handle: async params => {
    const data = await api<{ value?: RawPermission[] }>(`/me/drive/items/${params.item_id}/permissions`);
    return { permissions: (data.value ?? []).map(mapPermission) };
  },
});
