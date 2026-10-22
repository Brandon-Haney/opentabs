import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, workbookItemPath } from '../excel-api.js';
import {
  accessRoleInput,
  GRAPH_ROLE_FOR_ACCESS,
  type GraphListResponse,
  mapPermission,
  permissionSchema,
  type RawPermission,
} from './schemas.js';

export const shareWithPeople = defineTool({
  name: 'share_with_people',
  displayName: 'Share With People',
  description:
    'Give specific people access to the workbook open in the tab, like Share → Share with people. Recipients must sign in ' +
    'to open it. By default each recipient is emailed an invitation (with the optional message); set notify ' +
    'to false to grant access silently, which Microsoft records as a direct grant that update_permission can ' +
    'change later. Not retried on a transient failure, because a replay would send the invitation twice — ' +
    'check list_permissions before calling again.',
  summary: 'Share the workbook with specific people',
  icon: 'user-plus',
  group: 'Sharing',
  input: z.object({
    emails: z.array(z.string().email()).min(1).describe('Email addresses of the people to share with'),
    access: accessRoleInput.describe('view: read-only; edit: can change the workbook'),
    message: z.string().optional().describe('Message included in the invitation email'),
    notify: z.boolean().optional().describe('Email each recipient an invitation (default true)'),
  }),
  output: z.object({
    permissions: z.array(permissionSchema).describe('The access granted, one entry per recipient or shared link'),
  }),
  handle: async params => {
    const data = await api<GraphListResponse<RawPermission>>(`${await workbookItemPath()}/invite`, {
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
