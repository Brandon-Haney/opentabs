import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  buildScopeQuery,
  DEFAULT_LIMIT,
  equalsFragment,
  escapeQueryValue,
  incidentSchema,
  limitSchema,
  mapIncident,
  ORDER_BY_NEWEST,
  offsetSchema,
  type RawRecord,
  scopeSchema,
  TASK_FIELDS,
  textSearchQuery,
  totalSchema,
} from './schemas.js';

/**
 * Query fragments for the state words the tool accepts.
 *
 * 6 and 7 are the incident table's Resolved and Closed states; the other words describe a set of
 * states rather than one, so they filter on the `active` flag instead.
 */
const STATE_ALIASES: Record<string, string> = {
  active: 'active=true',
  open: 'active=true',
  resolved: 'state=6',
  closed: 'state=7',
};

const stateFragment = (state: string | undefined): string | undefined => {
  const cleaned = state ? escapeQueryValue(state) : '';
  if (!cleaned) return undefined;
  return STATE_ALIASES[cleaned.toLowerCase()] ?? `state=${cleaned}`;
};

export const searchIncidents = defineTool({
  name: 'search_incidents',
  displayName: 'Search Incidents',
  description:
    'Search incidents and return a page of summaries, newest updates first. Results are scoped to the groups the ' +
    'signed-in user belongs to unless "scope" says otherwise, because the instance holds millions of incidents and ' +
    'an unscoped search is both slow and rarely what a caller wants. Passing "assignment_group" or "assigned_to" ' +
    'replaces the scope entirely, so those filters search the whole instance. "query" matches as a case-insensitive ' +
    'substring of the number, short description, or description (e.g., "INC0010023" or "vpn"), and every other ' +
    'filter narrows it further. Each result carries the sys_id needed to read the full record, its comments, or ' +
    'its SLAs. Returns at most 100 incidents per call — use "offset" to page and "total" to see how many matched.',
  summary: 'Search incidents by text, state, priority, or assignee',
  icon: 'search',
  group: 'Incidents',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free text matched against the incident number, short description, and description'),
    scope: scopeSchema,
    state: z
      .string()
      .optional()
      .describe(
        'State filter. Accepts a stored state value ("1" New, "2" In Progress, "3" On Hold, "6" Resolved, ' +
          '"7" Closed), or one of the words "active" / "open" (any state still open), "resolved", "closed".',
      ),
    priority: z.string().optional().describe('Stored priority value: "1" Critical, "2" High, "3" Moderate, "4" Low'),
    assignment_group: z
      .string()
      .optional()
      .describe('sys_id of an assignment group. Supplying it searches every incident for that group, ignoring scope.'),
    assigned_to: z
      .string()
      .optional()
      .describe('sys_id of an assignee. Supplying it searches every incident for that user, ignoring scope.'),
    updated_since: z
      .string()
      .optional()
      .describe('Only return incidents updated on or after this date, written as YYYY-MM-DD (e.g., 2026-08-01)'),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    incidents: z.array(incidentSchema).describe('Matching incidents, most recently updated first'),
    total: totalSchema,
  }),
  handle: async params => {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const groupFragment = equalsFragment('assignment_group', params.assignment_group);
    const assigneeFragment = equalsFragment('assigned_to', params.assigned_to);
    const targetsSpecificAssignee = !!groupFragment || !!assigneeFragment;

    // ServiceNow has no parenthesised OR groups, so the text fragment's `^OR` clauses would widen every
    // condition placed after it. Keeping it last confines them to the fields it searches.
    const query = andQuery(
      targetsSpecificAssignee ? undefined : await buildScopeQuery(params.scope),
      groupFragment,
      assigneeFragment,
      stateFragment(params.state),
      equalsFragment('priority', params.priority),
      params.updated_since ? `sys_updated_on>=${escapeQueryValue(params.updated_since)}` : undefined,
      textSearchQuery(params.query),
      ORDER_BY_NEWEST,
    );

    const page = await tableQuery<RawRecord>('incident', {
      query,
      fields: TASK_FIELDS,
      limit,
      offset: params.offset,
    });

    return { incidents: page.records.map(mapIncident), total: page.total };
  },
});
