import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { DEFAULT_LIMIT, limitSchema, offsetSchema, type RawRecord, text, totalSchema } from './schemas.js';

const displayRecordSchema = z
  .record(z.string(), z.string())
  .describe('One record, keyed by field name, holding the display value of each requested field');

export const queryTable = defineTool({
  name: 'query_table',
  displayName: 'Query Table',
  description:
    'Escape hatch that reads any table with a raw encoded query. Reach for it only when no dedicated tool ' +
    'covers the need — the typed tools return mapped, documented fields, while this one returns display ' +
    'values only: a state reads "In Progress" and a reference reads the record name, never the sys_id a ' +
    'follow-up query would need. Query syntax: "field=value", "field!=value", "fieldLIKEsubstring", ' +
    '"fieldINvalue1,value2", "field>=2026-01-01", "fieldISEMPTY", joined with "^" for AND and "^OR" for OR, ' +
    'sorted by appending "^ORDERBYDESCsys_updated_on" or "^ORDERBYnumber". Always pass "fields" — omitting it ' +
    'returns every column of every matched row. Call describe_table first to confirm field names, and keep ' +
    'the query narrow: this instance holds millions of records.',
  summary: 'Run a raw encoded query against any table',
  icon: 'terminal',
  group: 'Platform',
  input: z.object({
    table: z
      .string()
      .min(1)
      .describe('Table to read, e.g. "incident", "change_request", "sc_req_item", "cmdb_ci", "sys_user_group"'),
    query: z
      .string()
      .optional()
      .describe(
        'Encoded query restricting which records are returned, e.g. "active=true^priority=1", ' +
          '"assignment_groupIN<group_sys_id>,<other_group_sys_id>", "short_descriptionLIKEprinter", or ' +
          '"active=true^ORDERBYDESCsys_updated_on". Omit to read the table unfiltered, which is slow and rarely useful.',
      ),
    fields: z
      .string()
      .optional()
      .describe(
        'Comma-separated field names to return, e.g. "number,short_description,state,assigned_to". Strongly ' +
          'recommended — omitting it returns every column on the table.',
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    records: z.array(displayRecordSchema).describe('Matching records, in the order the instance returned them'),
    total: totalSchema,
  }),
  handle: async params => {
    const page = await tableQuery<RawRecord>(params.table, {
      query: params.query,
      fields: params.fields,
      limit: params.limit ?? DEFAULT_LIMIT,
      offset: params.offset,
    });

    const records = page.records.map(record =>
      Object.fromEntries(Object.entries(record).map(([field, raw]) => [field, text(raw)])),
    );

    return { records, total: page.total };
  },
});
