import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { currentUser, currentUserGroupIds, tableQuery } from '../servicenow-api.js';
import {
  GROUP_FIELDS,
  groupSchema,
  MAX_GROUPS,
  mapGroup,
  mapUser,
  type RawRecord,
  USER_FIELDS,
  userSchema,
} from './schemas.js';

const readProfile = async (sysId: string): Promise<RawRecord | undefined> => {
  if (!sysId) return undefined;
  const page = await tableQuery<RawRecord>('sys_user', { query: `sys_id=${sysId}`, fields: USER_FIELDS, limit: 1 });
  return page.records[0];
};

const readGroups = async (groupIds: string[]): Promise<RawRecord[]> => {
  if (groupIds.length === 0) return [];
  const page = await tableQuery<RawRecord>('sys_user_group', {
    query: `sys_idIN${groupIds.join(',')}`,
    fields: GROUP_FIELDS,
    limit: MAX_GROUPS,
  });
  return page.records;
};

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Return the ServiceNow user the browser session is signed in as, along with every group that user belongs ' +
    'to. This is the starting point for scoping any search: the user sys_id returned here is what a "me" scope ' +
    'resolves to, and the group sys_ids are what a "my_groups" scope resolves to, so call this first when you ' +
    'need to filter records by assignment. Takes no arguments and reads no more than 200 groups.',
  summary: 'Signed-in user and the groups they belong to',
  icon: 'user',
  group: 'Users',
  input: z.object({}),
  output: z.object({
    user: userSchema.describe(
      'The signed-in user. Falls back to the identity reported by the session — sys_id, login name and display ' +
        'name only — when an access rule hides the sys_user record itself.',
    ),
    groups: z.array(groupSchema).describe('Groups the user belongs to, empty when they belong to none'),
  }),
  handle: async () => {
    const session = await currentUser();
    const sysId = session.user_sys_id ?? '';

    // An access rule can withhold the sys_user row even from the user it describes. The session
    // response still names them, and a session only exists for an account that is active.
    const profile = await readProfile(sysId);
    const user = mapUser(
      profile ?? { sys_id: sysId, user_name: session.user_name, name: session.user_display_name, active: 'true' },
    );

    const groups = await readGroups(await currentUserGroupIds());

    return { user, groups: groups.map(mapGroup) };
  },
});
