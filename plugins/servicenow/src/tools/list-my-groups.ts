import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { currentUserGroupIds, tableQuery } from '../servicenow-api.js';
import { GROUP_FIELDS, groupSchema, MAX_GROUPS, mapGroup, type RawRecord, totalSchema } from './schemas.js';

export const listMyGroups = defineTool({
  name: 'list_my_groups',
  displayName: 'List My Groups',
  description:
    'List the groups the signed-in ServiceNow user belongs to, each with its sys_id, description, email and ' +
    'manager. These are the groups a "my_groups" scope expands to, so use this to find the assignment group ' +
    'sys_id needed to filter incidents, changes or requests by team. Returns an empty list when the user ' +
    'belongs to no groups, and reads at most 200 memberships. Takes no arguments.',
  summary: 'Groups the signed-in user belongs to',
  icon: 'users-round',
  group: 'Users',
  input: z.object({}),
  output: z.object({
    groups: z.array(groupSchema).describe('Groups the signed-in user belongs to, ordered by name'),
    total: totalSchema,
  }),
  handle: async () => {
    const groupIds = await currentUserGroupIds();
    if (groupIds.length === 0) return { groups: [], total: 0 };

    const page = await tableQuery<RawRecord>('sys_user_group', {
      query: `sys_idIN${groupIds.join(',')}^ORDERBYname`,
      fields: GROUP_FIELDS,
      limit: MAX_GROUPS,
    });

    return { groups: page.records.map(mapGroup), total: page.total };
  },
});
