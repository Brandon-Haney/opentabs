import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { currentUserSysId, tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  DEFAULT_LIMIT,
  equalsFragment,
  escapeQueryValue,
  limitSchema,
  mapRequest,
  offsetSchema,
  ORDER_BY_NEWEST,
  type RawRecord,
  REQUEST_FIELDS,
  requestSchema,
  totalSchema,
} from './schemas.js';

export const searchRequests = defineTool({
  name: 'search_requests',
  displayName: 'Search Requests',
  description:
    'Searches service catalog requests (REQ records) in the sc_request table and returns the request number, ' +
    'short description, request state, approval state, the user the request was raised for, and the opened and ' +
    'last-updated timestamps. sc_request carries no assignment group or assigned-to field, so a request cannot be ' +
    'scoped to a fulfilment queue: this tool instead defaults to requests raised for the signed-in user, and ' +
    "searches another person's requests only when requested_for is supplied with their sys_id. Free text in " +
    '"query" is matched as a case-insensitive substring against the request number and short description only — ' +
    'sc_request has no description field. Only open requests are returned unless active_only is set to false. ' +
    'Results come back newest-updated first, at most 100 per call; page through the rest with offset. Use ' +
    'search_request_items to see the individual RITM line items that make up a request and how far each has ' +
    'progressed.',
  summary: 'Search catalog requests (REQ) raised for a user',
  icon: 'shopping-cart',
  group: 'Requests',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free text matched as a case-insensitive substring against the request number and short description ' +
          '(e.g., "laptop" or "REQ0010023"). Omit to list requests without a text filter.',
      ),
    requested_for: z
      .string()
      .optional()
      .describe(
        'sys_id of the user the request was raised for. Defaults to the signed-in user, so omit this to search ' +
          "your own requests; resolve another person's sys_id with a user lookup first.",
      ),
    state: z
      .string()
      .optional()
      .describe(
        'Stored value of the request_state field, matched exactly (e.g., "requested", "in_process", ' +
          '"closed_complete"). Read the exact value from request_state.value on a previous result.',
      ),
    active_only: z
      .boolean()
      .optional()
      .describe(
        'When true (the default), returns only requests that are still open. Set to false to include closed and ' +
          'cancelled requests.',
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    requests: z.array(requestSchema).describe('Matching requests, ordered newest-updated first'),
    total: totalSchema,
  }),
  handle: async params => {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const requestedFor =
      equalsFragment('requested_for', params.requested_for) ?? `requested_for=${await currentUserSysId()}`;
    const term = params.query ? escapeQueryValue(params.query) : '';

    const query = andQuery(
      requestedFor,
      equalsFragment('request_state', params.state),
      params.active_only === false ? undefined : 'active=true',
      term ? `numberLIKE${term}^ORshort_descriptionLIKE${term}` : undefined,
      ORDER_BY_NEWEST,
    );

    const page = await tableQuery<RawRecord>('sc_request', {
      query,
      fields: REQUEST_FIELDS,
      limit,
      offset: params.offset,
    });

    return { requests: page.records.map(mapRequest), total: page.total };
  },
});
