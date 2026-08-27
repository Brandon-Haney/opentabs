import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  anyOfFragment,
  buildScopeQuery,
  DEFAULT_LIMIT,
  limitSchema,
  mapProblem,
  ORDER_BY_NEWEST,
  offsetSchema,
  PROBLEM_FIELDS,
  problemSchema,
  type RawRecord,
  scopeSchema,
  textSearchQuery,
  totalSchema,
} from './schemas.js';

export const searchProblems = defineTool({
  name: 'search_problems',
  displayName: 'Search Problems',
  description:
    'Search problem records — the root causes tracked behind recurring incidents — and return a page of ' +
    'summaries, newest updates first. Each result carries the number, short description, state, priority, ' +
    'assignment, whether the problem is flagged as a known error, and any documented workaround, plus the sys_id ' +
    'needed to read the full record. Results are scoped to the groups the signed-in user belongs to unless ' +
    '"scope" says otherwise, because the instance holds millions of records and an unscoped search is both slow ' +
    'and rarely what a caller wants. Passing "assignment_group" or "assigned_to" replaces the scope entirely, so ' +
    'those filters search the whole instance. "query" matches as a case-insensitive substring of the number, ' +
    'short description, or description (e.g., "PRB0010023" or "latency"), and every other filter narrows it ' +
    'further. Returns at most 100 problems per call — use "offset" to page and "total" to see how many matched.',
  summary: 'Search problem records by text, state, or known-error flag',
  icon: 'search',
  group: 'Problems',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free text matched against the problem number, short description, and description'),
    scope: scopeSchema,
    state: z
      .string()
      .optional()
      .describe(
        'Stored state value rather than the label — the "state.value" of an earlier result. Accepts a ' +
          'comma-separated list to match any of several states at once.',
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
      .describe('sys_id of an assignment group. Supplying it searches every problem for that group, ignoring scope.'),
    assigned_to: z
      .string()
      .optional()
      .describe('sys_id of an assignee. Supplying it searches every problem for that user, ignoring scope.'),
    known_error: z
      .boolean()
      .optional()
      .describe(
        'Restrict to problems flagged as known errors (true) or to those not flagged (false). Omit to return both.',
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    problems: z.array(problemSchema).describe('Matching problem records, most recently updated first'),
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
      params.known_error === undefined ? undefined : `known_error=${params.known_error}`,
      textSearchQuery(params.query),
      ORDER_BY_NEWEST,
    );

    const page = await tableQuery<RawRecord>('problem', {
      query,
      fields: PROBLEM_FIELDS,
      limit,
      offset: params.offset,
    });

    return { problems: page.records.map(mapProblem), total: page.total };
  },
});
