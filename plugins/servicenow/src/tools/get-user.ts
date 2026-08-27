import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, isSysId, mapUser, type RawRecord, USER_FIELDS, userSchema } from './schemas.js';

/** Chooses the lookup field from the shape of the identifier the caller supplied. */
const buildLookupQuery = (identifier: string): string => {
  if (isSysId(identifier)) return `sys_id=${identifier}`;
  if (identifier.includes('@')) return `email=${identifier}^ORuser_name=${identifier}`;
  return `user_name=${identifier}`;
};

export const getUser = defineTool({
  name: 'get_user',
  displayName: 'Get User',
  description:
    'Read one ServiceNow user record by sys_id, login name, or email address, returning their full name, ' +
    'title, department, manager and whether the account is active. The identifier is resolved by shape: 32 hex ' +
    'characters are treated as a sys_id, anything containing "@" is matched against the email address and then ' +
    'the login name, and everything else is matched against the login name exactly. Use search_users when you ' +
    'only have part of a name; this tool errors rather than guessing when nothing matches exactly.',
  summary: 'Read one user by sys_id, login name, or email',
  icon: 'user-search',
  group: 'Users',
  input: z.object({
    user: z.string().min(1).describe('sys_id (32 hex characters), login name, or email address of the user to read'),
  }),
  output: z.object({
    user: userSchema.describe('The matching user record'),
  }),
  handle: async params => {
    const identifier = escapeQueryValue(params.user);
    if (!identifier) throw ToolError.validation('Provide a sys_id, login name, or email address to look up.');

    const page = await tableQuery<RawRecord>('sys_user', {
      query: buildLookupQuery(identifier),
      fields: USER_FIELDS,
      limit: 1,
    });

    const record = page.records[0];
    if (!record) throw ToolError.notFound(`No ServiceNow user matches "${params.user}".`);

    return { user: mapUser(record) };
  },
});
