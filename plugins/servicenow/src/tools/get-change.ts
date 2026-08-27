import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { CHANGE_FIELDS, changeSchema, escapeQueryValue, isSysId, mapChange, type RawRecord } from './schemas.js';

export const getChange = defineTool({
  name: 'get_change',
  displayName: 'Get Change',
  description:
    'Read one change request, addressed either by its number (e.g., CHG0010023) or by its 32-character sys_id. ' +
    'Returns the short description, state, priority, risk, change type, assignment, the planned start and end of ' +
    'the change window, and the timestamps for when it was opened and last updated. The lookup is not scoped to ' +
    'the signed-in user — any change the user is permitted to read can be fetched. Raises a not-found error when ' +
    'nothing matches, which is also what an access rule hiding the record looks like.',
  summary: 'Read one change request by number or sys_id',
  icon: 'file-text',
  group: 'Changes',
  input: z.object({
    change: z
      .string()
      .min(1)
      .describe('Change number (e.g., CHG0010023) or the 32-character sys_id of the change request'),
  }),
  output: z.object({
    change: changeSchema.describe('The matched change request'),
  }),
  handle: async params => {
    const identifier = params.change.trim();
    const query = isSysId(identifier) ? `sys_id=${identifier}` : `number=${escapeQueryValue(identifier)}`;

    const page = await tableQuery<RawRecord>('change_request', { query, fields: CHANGE_FIELDS, limit: 1 });

    const record = page.records[0];
    if (!record) {
      throw ToolError.notFound(
        `No change matches "${identifier}" — check the number, or the record may be restricted.`,
      );
    }

    return { change: mapChange(record) };
  },
});
