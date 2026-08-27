import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableMeta } from '../servicenow-api.js';
import { choiceSchema } from './schemas.js';

export const listFieldChoices = defineTool({
  name: 'list_field_choices',
  displayName: 'List Field Choices',
  description:
    'List every value a choice field accepts, carrying both the label a human reads and the value a query ' +
    'needs — an incident state reads as label "In Progress" / value "2", so the matching condition is ' +
    '"state=2", never "state=In Progress". Read choices through this tool rather than the sys_choice table, ' +
    'which access rules usually withhold even from users who can read the records those choices describe. ' +
    'Call `describe_table` first to find the exact field name and to see which columns carry choices at all; ' +
    'a column that exists but is free-form returns an empty list rather than an error.',
  summary: 'List the allowed values of a choice field',
  icon: 'list-checks',
  group: 'Platform',
  input: z.object({
    table: z.string().min(1).describe('Table the field belongs to, e.g. "incident", "change_request", "sc_req_item"'),
    field: z
      .string()
      .min(1)
      .describe('Field name exactly as `describe_table` reports it, e.g. "state", "priority", "category"'),
  }),
  output: z.object({
    table: z.string().describe('Table the field belongs to'),
    field: z.string().describe('Field name that was inspected'),
    label: z.string().describe('Label shown for the field in the ServiceNow UI'),
    choices: z
      .array(choiceSchema)
      .describe('Values the field accepts, empty when the column exists but is free-form rather than a choice list'),
    total: z.number().int().describe('Number of choices returned'),
  }),
  handle: async params => {
    const columns = await tableMeta(params.table);
    const column = columns[params.field];

    if (!column) {
      throw ToolError.notFound(
        `Field "${params.field}" does not exist on table "${params.table}" — call describe_table to list its columns.`,
      );
    }

    const choices = (column.choices ?? []).map(entry => ({ label: entry.label ?? '', value: entry.value ?? '' }));

    return { table: params.table, field: params.field, label: column.label ?? '', choices, total: choices.length };
  },
});
