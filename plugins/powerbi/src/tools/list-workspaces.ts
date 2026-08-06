import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type PowerBiListResponse, api } from '../powerbi-api.js';
import { type RawWorkspace, mapWorkspace, workspaceSchema } from './schemas.js';

export const listWorkspaces = defineTool({
  name: 'list_workspaces',
  displayName: 'List Workspaces',
  description:
    'List the Power BI workspaces the signed-in user is a member of. ' +
    'An empty result is normal and not an error: a read-only consumer who receives content through published apps belongs to no workspaces, even while reaching many reports and models. ' +
    'When this returns nothing, use list_reports and list_datasets instead — they surface content reached through apps, and every workspace-scoped endpoint will reject this user anyway.',
  summary: 'List workspaces the user belongs to',
  icon: 'folders',
  group: 'Workspaces',
  input: z.object({}),
  output: z.object({
    workspaces: z.array(workspaceSchema).describe('Workspaces the user is a member of, possibly empty'),
  }),
  handle: async () => {
    const data = await api<PowerBiListResponse<RawWorkspace>>('/groups');
    return { workspaces: (data.value ?? []).map(mapWorkspace) };
  },
});
