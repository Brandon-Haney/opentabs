import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableGet, tableQuery } from '../servicenow-api.js';
import {
  escapeQueryValue,
  isSysId,
  mapRequestItem,
  type RawRecord,
  REQUEST_ITEM_FIELDS,
  requestItemSchema,
} from './schemas.js';

const findRequestItem = async (identifier: string): Promise<RawRecord | null> => {
  if (isSysId(identifier)) return tableGet<RawRecord>('sc_req_item', identifier, REQUEST_ITEM_FIELDS);

  const page = await tableQuery<RawRecord>('sc_req_item', {
    query: `number=${identifier.toUpperCase()}`,
    fields: REQUEST_ITEM_FIELDS,
    limit: 1,
  });

  return page.records[0] ?? null;
};

export const getRequestItem = defineTool({
  name: 'get_request_item',
  displayName: 'Get Request Item',
  description:
    'Fetches one requested item (RITM record) from the sc_req_item table by its number or sys_id. Returns the ' +
    'item number, short description, state, priority, fulfilment stage, the catalog item that was ordered, the ' +
    'parent request (REQ), the user it was requested for, the assigned user and group, and the opened and ' +
    'last-updated timestamps. A 32-character hexadecimal value is treated as a sys_id; anything else is matched ' +
    'against the display number. Raises a not-found error when no item matches the identifier or an access ' +
    'control rule hides it from the signed-in user.',
  summary: 'Get one requested item (RITM) by number or sys_id',
  icon: 'file-text',
  group: 'Requests',
  input: z.object({
    item: z
      .string()
      .min(1)
      .describe('Requested item number (e.g., RITM0010023) or the 32-character sys_id of the sc_req_item record'),
  }),
  output: z.object({
    item: requestItemSchema.describe('The requested item'),
  }),
  handle: async params => {
    const identifier = escapeQueryValue(params.item);
    const record = await findRequestItem(identifier);

    if (!record) {
      throw ToolError.notFound(
        `No requested item found for "${params.item}" — check the RITM number or sys_id, and that the signed-in user can read it.`,
      );
    }

    return { item: mapRequestItem(record) };
  },
});
