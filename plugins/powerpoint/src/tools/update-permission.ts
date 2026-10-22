import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import {
  accessRoleInput,
  driveIdInput,
  GRAPH_ROLE_FOR_ACCESS,
  mapPermission,
  permissionSchema,
  type RawPermission,
} from './schemas.js';

export const updatePermission = defineTool({
  name: 'update_permission',
  displayName: 'Update Permission',
  description:
    'Change a direct grant on a file or folder between view and edit. Take the permission id from ' +
    'list_permissions; only entries of kind "direct" can change. People added through a sharing link of ' +
    'scope "users" (what the Share dialog creates) hold the role of the link, which Microsoft does not let ' +
    'anyone change: to move such a person to another access level, share_with_people at the new level with ' +
    'notify false, then remove_from_link on the old link. Inherited permissions must be changed on the folder ' +
    'or site they come from.',
  summary: 'Change a direct grant between view and edit',
  icon: 'user-cog',
  group: 'Sharing',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file or folder'),
    permission_id: z.string().min(1).describe('Permission ID of a direct grant, from list_permissions'),
    access: accessRoleInput.describe('view: read-only; edit: can change the item'),
  }),
  output: z.object({
    permission: permissionSchema.describe('The updated permission'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    const permissionPath = `/drives/${driveId}/items/${params.item_id}/permissions/${encodeURIComponent(params.permission_id)}`;
    // Graph rejects a role change on a sharing link with a bare 400, so links
    // are turned away here with the steps that do change a person's access.
    const current = await api<RawPermission>(permissionPath);
    if (current.link) {
      throw ToolError.validation(
        `Permission ${params.permission_id} is a sharing link, and a link's role cannot change. To change a ` +
          "person's access, call share_with_people at the new level with notify false, then remove_from_link " +
          'on this link. To change who a link works for, create a new link and delete this one.',
      );
    }
    const data = await api<RawPermission>(permissionPath, {
      method: 'PATCH',
      // Setting a fixed role leaves the same state however many times it lands.
      retryNonIdempotent: true,
      body: { roles: [GRAPH_ROLE_FOR_ACCESS[params.access]] },
    });
    return { permission: mapPermission(data) };
  },
});
