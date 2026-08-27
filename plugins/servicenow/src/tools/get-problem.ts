import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, isSysId, mapProblem, PROBLEM_FIELDS, problemSchema, type RawRecord } from './schemas.js';

export const getProblem = defineTool({
  name: 'get_problem',
  displayName: 'Get Problem',
  description:
    'Read one problem record, addressed either by its number (e.g., PRB0010023) or by its 32-character sys_id. ' +
    'Returns the short description, state, priority, assignment, whether the problem is flagged as a known error, ' +
    'and any documented workaround, along with the timestamps for when it was opened and last updated. The lookup ' +
    'is not scoped to the signed-in user — any problem the user is permitted to read can be fetched. Raises a ' +
    'not-found error when nothing matches, which is also what an access rule hiding the record looks like.',
  summary: 'Read one problem record by number or sys_id',
  icon: 'file-text',
  group: 'Problems',
  input: z.object({
    problem: z
      .string()
      .min(1)
      .describe('Problem number (e.g., PRB0010023) or the 32-character sys_id of the problem record'),
  }),
  output: z.object({
    problem: problemSchema.describe('The matched problem record'),
  }),
  handle: async params => {
    const identifier = params.problem.trim();
    const query = isSysId(identifier) ? `sys_id=${identifier}` : `number=${escapeQueryValue(identifier)}`;

    const page = await tableQuery<RawRecord>('problem', { query, fields: PROBLEM_FIELDS, limit: 1 });

    const record = page.records[0];
    if (!record) {
      throw ToolError.notFound(
        `No problem matches "${identifier}" — check the number, or the record may be restricted.`,
      );
    }

    return { problem: mapProblem(record) };
  },
});
