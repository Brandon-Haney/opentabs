import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  DEFAULT_LIMIT,
  equalsFragment,
  escapeQueryValue,
  limitSchema,
  mapUser,
  offsetSchema,
  type RawRecord,
  totalSchema,
  USER_FIELDS,
  userSchema,
} from './schemas.js';

export const searchUsers = defineTool({
  name: 'search_users',
  displayName: 'Search Users',
  description:
    'Search the ServiceNow user directory (sys_user) by name, login name or email address, returning each ' +
    'match with its sys_id, title, department and manager. The search term is a case-insensitive substring ' +
    'match against all three fields at once, so "smith" finds both a full name and a login name containing it. ' +
    'Only active accounts are searched unless active_only is set to false. Results are ordered by name and ' +
    'capped at 100 per call — narrow the term or page with offset rather than raising the limit.',
  summary: 'Find users by name, login name, or email',
  icon: 'users',
  group: 'Users',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text term matched as a substring against name, user_name and email. Omit to list the directory ' +
          'ordered by name, which is only useful alongside a department filter.',
      ),
    active_only: z
      .boolean()
      .optional()
      .describe('Restrict the search to active accounts (default true). Set false to include disabled accounts.'),
    department: z
      .string()
      .optional()
      .describe('sys_id of a department, to return only users belonging to it. Omit to search every department.'),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    users: z.array(userSchema).describe('Matching users, ordered by name'),
    total: totalSchema,
  }),
  handle: async params => {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const activeOnly = params.active_only ?? true;
    const term = params.query ? escapeQueryValue(params.query) : '';

    const query = andQuery(
      activeOnly ? 'active=true' : undefined,
      equalsFragment('department', params.department),
      term ? `nameLIKE${term}^ORuser_nameLIKE${term}^ORemailLIKE${term}` : undefined,
      'ORDERBYname',
    );

    const page = await tableQuery<RawRecord>('sys_user', { query, fields: USER_FIELDS, limit, offset: params.offset });

    return { users: page.records.map(mapUser), total: page.total };
  },
});
