import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  DEFAULT_LIMIT,
  escapeQueryValue,
  isSysId,
  limitSchema,
  mapUser,
  offsetSchema,
  type RawRecord,
  totalSchema,
  USER_FIELDS,
  userSchema,
  value,
} from './schemas.js';

const resolveGroupSysId = async (group: string): Promise<string> => {
  const identifier = escapeQueryValue(group);
  if (isSysId(identifier)) return identifier;

  const page = await tableQuery<RawRecord>('sys_user_group', {
    query: `name=${identifier}`,
    fields: 'sys_id',
    limit: 1,
  });

  const match = page.records[0];
  if (!match) throw ToolError.notFound(`No ServiceNow group is named "${group}".`);

  return value(match.sys_id);
};

export const listGroupMembers = defineTool({
  name: 'list_group_members',
  displayName: 'List Group Members',
  description:
    'List the users who belong to a ServiceNow group, each with their sys_id, login name, email, title and ' +
    'manager. The group is identified either by sys_id or by its exact name — a name is resolved against ' +
    'sys_user_group first and errors when no group carries it, so use list_my_groups or search_users to ' +
    'discover the exact spelling. Membership is read in pages of at most 100; total reports how many members ' +
    'the group has in all. Returns an empty list for a group with no members.',
  summary: 'List the users belonging to a group',
  icon: 'user-check',
  group: 'Users',
  input: z.object({
    group: z
      .string()
      .min(1)
      .describe('sys_id (32 hex characters) of a group, or its exact name as shown in ServiceNow'),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    members: z.array(userSchema).describe('Users belonging to the group, ordered by name'),
    total: totalSchema,
  }),
  handle: async params => {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const groupSysId = await resolveGroupSysId(params.group);

    const membership = await tableQuery<RawRecord>('sys_user_grmember', {
      query: `group=${groupSysId}`,
      fields: 'user',
      limit,
      offset: params.offset,
    });

    const userIds = membership.records.map(record => value(record.user)).filter(id => id.length > 0);
    if (userIds.length === 0) return { members: [], total: membership.total };

    const users = await tableQuery<RawRecord>('sys_user', {
      query: `sys_idIN${userIds.join(',')}^ORDERBYname`,
      fields: USER_FIELDS,
      limit: userIds.length,
    });

    return { members: users.records.map(mapUser), total: membership.total };
  },
});
