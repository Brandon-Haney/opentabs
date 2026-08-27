import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  anyOfFragment,
  buildScopeQuery,
  CHANGE_FIELDS,
  changeSchema,
  DEFAULT_LIMIT,
  escapeQueryValue,
  limitSchema,
  mapChange,
  ORDER_BY_NEWEST,
  offsetSchema,
  type RawRecord,
  scopeSchema,
  textSearchQuery,
  totalSchema,
} from './schemas.js';

export const searchChanges = defineTool({
  name: 'search_changes',
  displayName: 'Search Changes',
  description:
    'Search change requests and return a page of summaries, newest updates first. Each result carries the number, ' +
    'short description, state, priority, risk, change type, assignment, and the planned start and end of the ' +
    'change window, plus the sys_id needed to read the full record. Results are scoped to the groups the ' +
    'signed-in user belongs to unless "scope" says otherwise, because the instance holds millions of records and ' +
    'an unscoped search is both slow and rarely what a caller wants. Passing "assignment_group" or "assigned_to" ' +
    'replaces the scope entirely, so those filters search the whole instance. "query" matches as a ' +
    'case-insensitive substring of the number, short description, or description (e.g., "CHG0010023" or ' +
    '"firewall"), and every other filter narrows it further. Returns at most 100 changes per call — use "offset" ' +
    'to page and "total" to see how many matched.',
  summary: 'Search change requests by text, state, type, or assignee',
  icon: 'git-pull-request',
  group: 'Changes',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free text matched against the change number, short description, and description'),
    scope: scopeSchema,
    state: z
      .string()
      .optional()
      .describe(
        'Stored state value rather than the label — the "state.value" of an earlier result. The change table ' +
          'runs through many states, so pass a comma-separated list to match any of several at once.',
      ),
    priority: z
      .string()
      .optional()
      .describe(
        'Stored priority value: "1" Critical, "2" High, "3" Moderate, "4" Low. Accepts a comma-separated list.',
      ),
    assignment_group: z
      .string()
      .optional()
      .describe('sys_id of an assignment group. Supplying it searches every change for that group, ignoring scope.'),
    assigned_to: z
      .string()
      .optional()
      .describe('sys_id of an assignee. Supplying it searches every change for that user, ignoring scope.'),
    updated_since: z
      .string()
      .optional()
      .describe('Only return changes updated on or after this date, written as YYYY-MM-DD (e.g., 2026-08-01)'),
    type: z
      .string()
      .optional()
      .describe(
        'Stored change type value: "standard", "normal", or "emergency". Accepts a comma-separated list to match ' +
          'any of several types.',
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    changes: z.array(changeSchema).describe('Matching change requests, most recently updated first'),
    total: totalSchema,
  }),
  handle: async params => {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const groupFragment = anyOfFragment('assignment_group', params.assignment_group);
    const assigneeFragment = anyOfFragment('assigned_to', params.assigned_to);
    const targetsSpecificAssignee = !!groupFragment || !!assigneeFragment;

    const query = andQuery(
      targetsSpecificAssignee ? undefined : await buildScopeQuery(params.scope),
      groupFragment,
      assigneeFragment,
      anyOfFragment('state', params.state),
      anyOfFragment('priority', params.priority),
      anyOfFragment('type', params.type),
      params.updated_since ? `sys_updated_on>=${escapeQueryValue(params.updated_since)}` : undefined,
      textSearchQuery(params.query),
      ORDER_BY_NEWEST,
    );

    const page = await tableQuery<RawRecord>('change_request', {
      query,
      fields: CHANGE_FIELDS,
      limit,
      offset: params.offset,
    });

    return { changes: page.records.map(mapChange), total: page.total };
  },
});
