import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type RawColumn, tableMeta } from '../servicenow-api.js';

const MAX_COLUMNS = 300;

/**
 * Column types that back no stored value an encoded query can match — write-only journal inputs,
 * catalog variable containers, image blobs and list widgets that exist only on the form.
 */
const UNFILTERABLE_TYPES = new Set([
  'collection',
  'documentation_field',
  'glide_var',
  'journal_input',
  'related_tags',
  'template_value',
  'user_image',
  'variables',
]);

const columnType = (column: RawColumn): string => column.type ?? column.internal_type ?? '';

export const describeTable = defineTool({
  name: 'describe_table',
  displayName: 'Describe Table',
  description:
    'List the columns of a ServiceNow table — field name, UI label, type, referenced table, mandatory and ' +
    'read-only flags, and how many preset choices each column offers. This is the authoritative way to ' +
    'discover the field names that `query_table` and every encoded query expect, because the sys_choice ' +
    'table is usually withheld by access rules. Use each returned `name` verbatim in a query condition and ' +
    'in a comma-separated fields list; when `choice_count` is above zero, call `list_field_choices` to read ' +
    'the values that column accepts. Columns are sorted by field name and capped at 300 while ' +
    '`total_columns` reports how many actually matched — narrow a wide table with `search` or ' +
    '`filterable_only` rather than paging.',
  summary: 'List the columns of a table',
  icon: 'table-properties',
  group: 'Platform',
  input: z.object({
    table: z
      .string()
      .min(1)
      .describe('Table name to describe, e.g. "incident", "change_request", "sc_req_item", "cmdb_ci"'),
    filterable_only: z
      .boolean()
      .optional()
      .describe(
        'When true, return only columns an encoded query can filter on — write-only journal inputs, catalog ' +
          'variable containers, image blobs and form-only list widgets are dropped (default false).',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring matched against each column name and label, e.g. "group" to find ' +
          'assignment_group. Omit to return every column.',
      ),
  }),
  output: z.object({
    table: z.string().describe('Table the columns belong to'),
    columns: z
      .array(
        z.object({
          name: z.string().describe('Field name — use this verbatim in an encoded query and in a fields list'),
          label: z.string().describe('Label shown for the field in the ServiceNow UI'),
          type: z.string().describe('Internal field type, e.g. string, reference, glide_date_time, boolean, integer'),
          reference: z.string().describe('Table this column references, empty for non-reference columns'),
          mandatory: z.boolean().describe('Whether the field must be set before a record can be saved'),
          read_only: z.boolean().describe('Whether the field is read-only'),
          choice_count: z
            .number()
            .int()
            .describe('Number of preset choices the column accepts, 0 when the column is free-form'),
          hint: z.string().describe('Hint text shown for the field on the form, empty when unset'),
        }),
      )
      .describe('Matching columns, sorted by field name and capped at 300'),
    total_columns: z
      .number()
      .int()
      .describe('Number of columns matching the filters, which exceeds the returned array when the cap applies'),
  }),
  handle: async params => {
    const filterableOnly = params.filterable_only ?? false;
    const search = params.search?.trim().toLowerCase() ?? '';
    const columns = await tableMeta(params.table);

    const matched = Object.entries(columns)
      .filter(([name, column]) => {
        if (filterableOnly && UNFILTERABLE_TYPES.has(columnType(column))) return false;
        if (!search) return true;
        return name.toLowerCase().includes(search) || (column.label ?? '').toLowerCase().includes(search);
      })
      .map(([name, column]) => ({
        name: column.name ?? name,
        label: column.label ?? '',
        type: columnType(column),
        reference: column.reference ?? '',
        mandatory: column.mandatory === true,
        read_only: column.read_only === true,
        choice_count: column.choices?.length ?? 0,
        hint: column.hint ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { table: params.table, columns: matched.slice(0, MAX_COLUMNS), total_columns: matched.length };
  },
});
