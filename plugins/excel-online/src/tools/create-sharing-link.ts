import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, workbookItemPath } from '../excel-api.js';
import { mapPermission, permissionSchema, type RawPermission } from './schemas.js';

export const createSharingLink = defineTool({
  name: 'create_sharing_link',
  displayName: 'Create Sharing Link',
  description:
    'Create a sharing link to the workbook open in the tab, like Share → Copy link. Returns the existing link ' +
    'when one of the same type and scope already exists. Organization links work for anyone signed in to the ' +
    'organization; anonymous links work for anyone holding the URL and are often disabled by tenant policy. To ' +
    'give specific people access, use share_with_people.',
  summary: 'Create a sharing link to the workbook',
  icon: 'link',
  group: 'Sharing',
  input: z.object({
    type: z.enum(['view', 'edit']).describe('view: read-only; edit: can change the workbook'),
    scope: z.enum(['organization', 'anonymous']).optional().describe('Who the link works for (default "organization")'),
  }),
  output: z.object({
    permission: permissionSchema.describe('The sharing link'),
  }),
  handle: async params => {
    const data = await api<RawPermission>(`${await workbookItemPath()}/createLink`, {
      method: 'POST',
      // Graph returns the existing link when one of this type and scope already
      // exists, so replaying the POST after a transient failure is idempotent.
      retryNonIdempotent: true,
      body: { type: params.type, scope: params.scope ?? 'organization' },
    });
    return { permission: mapPermission(data) };
  },
});
