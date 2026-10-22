import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput, mapPermission, permissionSchema, type RawPermission } from './schemas.js';

export const createSharingLink = defineTool({
  name: 'create_sharing_link',
  displayName: 'Create Sharing Link',
  description:
    'Create a sharing link to a file or folder, like Share → Copy link. Returns the existing link when one of ' +
    'the same type and scope already exists. Organization links work for anyone signed in to the organization; ' +
    'anonymous links work for anyone holding the URL and are often disabled by tenant policy. Embed links exist ' +
    'only on personal OneDrive. To give specific people access, use share_with_people.',
  summary: 'Create a sharing link to a file or folder',
  icon: 'link',
  group: 'Sharing',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file or folder'),
    type: z.enum(['view', 'edit', 'embed']).describe('view: read-only; edit: can change the item; embed: embeddable'),
    scope: z.enum(['organization', 'anonymous']).optional().describe('Who the link works for (default "organization")'),
  }),
  output: z.object({
    permission: permissionSchema.describe('The sharing link'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    const data = await api<RawPermission>(`/drives/${driveId}/items/${params.item_id}/createLink`, {
      method: 'POST',
      // Graph returns the existing link when one of this type and scope already
      // exists, so replaying the POST after a transient failure is idempotent.
      retryNonIdempotent: true,
      body: { type: params.type, scope: params.scope ?? 'organization' },
    });
    return { permission: mapPermission(data) };
  },
});
