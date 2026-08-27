import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  buildScopeQuery,
  DEFAULT_LIMIT,
  equalsFragment,
  limitSchema,
  mapRequestItem,
  offsetSchema,
  ORDER_BY_NEWEST,
  type RawRecord,
  REQUEST_ITEM_FIELDS,
  requestItemSchema,
  scopeSchema,
  textSearchQuery,
  totalSchema,
} from './schemas.js';

export const searchRequestItems = defineTool({
  name: 'search_request_items',
  displayName: 'Search Request Items',
  description:
    'Searches requested items (RITM records) in the sc_req_item table — the individual catalog line items that ' +
    'fulfilment teams actually work. Returns the RITM number, short description, state, priority, fulfilment ' +
    'stage, the catalog item ordered, the parent request (REQ), the user it was requested for, and the assigned ' +
    'user and group. The instance holds millions of records, so the search defaults to items assigned to any ' +
    'group the signed-in user belongs to: pass scope "me" for only your own items, or scope "all" to reach the ' +
    'whole instance. Passing "assignment_group" or "assigned_to" replaces the scope entirely. Free text in ' +
    '"query" matches as a case-insensitive substring of the number, short description, and description. Pass ' +
    '"request" with a REQ sys_id to list just that request\'s items. Newest-updated first, at most 100 per call.',
  summary: 'Search requested items (RITM) by text, state, or queue',
  icon: 'package',
  group: 'Requests',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free text matched as a case-insensitive substring against the item number, short description, and ' +
          'description (e.g., "laptop" or "RITM0010023"). Omit to list items without a text filter.',
      ),
    scope: scopeSchema,
    state: z
      .string()
      .optional()
      .describe(
        'Stored value of the state field, matched exactly (e.g., "1" for Open, "3" for Closed Complete). Read ' +
          'the exact value from state.value on a previous result.',
      ),
    assignment_group: z
      .string()
      .optional()
      .describe(
        'sys_id of a group; narrows the results to items assigned to it. Combine with scope "all" to search a ' +
          'queue the signed-in user does not belong to.',
      ),
    assigned_to: z.string().optional().describe('sys_id of a user; narrows the results to items assigned to them'),
    request: z
      .string()
      .optional()
      .describe('sys_id of the parent request (REQ); returns only the items belonging to that request'),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    items: z.array(requestItemSchema).describe('Matching requested items, ordered newest-updated first'),
    total: totalSchema,
  }),
  handle: async params => {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const groupFragment = equalsFragment('assignment_group', params.assignment_group);
    const assigneeFragment = equalsFragment('assigned_to', params.assigned_to);
    const targetsSpecificAssignee = !!groupFragment || !!assigneeFragment;

    const query = andQuery(
      targetsSpecificAssignee ? undefined : await buildScopeQuery(params.scope),
      equalsFragment('state', params.state),
      groupFragment,
      assigneeFragment,
      equalsFragment('request', params.request),
      textSearchQuery(params.query),
      ORDER_BY_NEWEST,
    );

    const page = await tableQuery<RawRecord>('sc_req_item', {
      query,
      fields: REQUEST_ITEM_FIELDS,
      limit,
      offset: params.offset,
    });

    return { items: page.records.map(mapRequestItem), total: page.total };
  },
});
