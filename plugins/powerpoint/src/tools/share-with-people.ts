import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import {
  accessRoleInput,
  driveIdInput,
  GRAPH_ROLE_FOR_ACCESS,
  type GraphCollection,
  mapPermission,
  permissionSchema,
  type RawPermission,
} from './schemas.js';

export const shareWithPeople = defineTool({
  name: 'share_with_people',
  displayName: 'Share With People',
  description:
    'Give specific people access to a file or folder, like Share → Share with people. Recipients must sign in ' +
    'to open it. By default each recipient is emailed an invitation (with the optional message); set notify ' +
    'to false to grant access silently, which Microsoft records as a direct grant that update_permission can ' +
    'change later. Not retried on a transient failure, because a replay would send the invitation twice — ' +
    'check list_permissions before calling again.',
  summary: 'Share a file or folder with specific people',
  icon: 'user-plus',
  group: 'Sharing',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file or folder'),
    emails: z.array(z.string().email()).min(1).describe('Email addresses of the people to share with'),
    access: accessRoleInput.describe('view: read-only; edit: can change the item'),
    message: z.string().optional().describe('Message included in the invitation email'),
    notify: z.boolean().optional().describe('Email each recipient an invitation (default true)'),
  }),
  output: z.object({
    permissions: z.array(permissionSchema).describe('The access granted, one entry per recipient or shared link'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    const data = await api<GraphCollection<RawPermission>>(`/drives/${driveId}/items/${params.item_id}/invite`, {
      method: 'POST',
      body: {
        recipients: params.emails.map(email => ({ email })),
        roles: [GRAPH_ROLE_FOR_ACCESS[params.access]],
        requireSignIn: true,
        sendInvitation: params.notify ?? true,
        ...(params.message !== undefined ? { message: params.message } : {}),
      },
    });
    return { permissions: (data.value ?? []).map(mapPermission) };
  },
});
