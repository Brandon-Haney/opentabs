import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../microsoft-word-api.js';
import { mapPermission, permissionSchema, type RawPermission } from './schemas.js';

export const removeFromLink = defineTool({
  name: 'remove_from_link',
  displayName: 'Remove People From Link',
  description:
    'Remove specific people from a sharing link of scope "users" on a file or folder, leaving the link working ' +
    'for everyone else on it. This is how to take one person off an item shared with several people at once. ' +
    'They keep any access they hold through another link, a direct grant or a group. Take the permission id ' +
    'from list_permissions; to revoke the whole link, use delete_permission.',
  summary: 'Remove people from a specific-people sharing link',
  icon: 'user-minus',
  group: 'Sharing',
  input: z.object({
    item_id: z.string().describe('File or folder ID'),
    permission_id: z
      .string()
      .min(1)
      .describe('Permission ID of a sharing link of scope "users", from list_permissions'),
    emails: z.array(z.string().email()).min(1).describe('Email addresses of the people to remove from the link'),
  }),
  output: z.object({
    permission: permissionSchema.describe('The sharing link, listing the people still on it'),
  }),
  handle: async params => {
    const data = await api<RawPermission>(
      `/me/drive/items/${params.item_id}/permissions/${encodeURIComponent(params.permission_id)}/revokeGrants`,
      {
        method: 'POST',
        body: { grantees: params.emails.map(email => ({ email })) },
      },
    );
    return { permission: mapPermission(data) };
  },
});
