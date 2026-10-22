import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, workbookItemPath } from '../excel-api.js';
import { type GraphListResponse, mapPermission, permissionSchema, type RawPermission } from './schemas.js';

export const listPermissions = defineTool({
  name: 'list_permissions',
  displayName: 'List Permissions',
  description:
    'List who can open the workbook open in the tab: every sharing link (with its scope) and every person or group ' +
    'granted access directly, with their role. Inherited entries come from the folder or site and cannot be ' +
    'changed on the workbook itself.',
  summary: 'List who has access to the workbook',
  icon: 'shield',
  group: 'Sharing',
  input: z.object({}),
  output: z.object({
    permissions: z.array(permissionSchema).describe('Sharing links and direct grants on the workbook'),
  }),
  handle: async () => {
    const data = await api<GraphListResponse<RawPermission>>(`${await workbookItemPath()}/permissions`);
    return { permissions: (data.value ?? []).map(mapPermission) };
  },
});
