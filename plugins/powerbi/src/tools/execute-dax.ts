import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { runDaxQuery } from '../dax.js';
import { daxRowSchema } from './schemas.js';

/** Rows returned to the caller when `max_rows` is omitted. */
const DEFAULT_MAX_ROWS = 200;

export const executeDax = defineTool({
  name: 'execute_dax',
  displayName: 'Execute DAX',
  description:
    'Run a DAX query against a Power BI semantic model and return the result rows. ' +
    'The query must start with EVALUATE (optionally preceded by DEFINE); exactly one query runs per call. ' +
    'Get a dataset_id from list_datasets or list_reports — the same ID appears as "dataset_id" on an Excel workbook connection, so a Power BI-backed workbook can be queried directly. ' +
    'Call describe_dataset first for real table, column, and measure names; identifiers are case-sensitive and need quoting when they contain spaces. ' +
    'Column names come back bracketed, e.g. "[Total Sales]", and blanks are returned as null rather than omitted. ' +
    'Prefer limiting rows in the query (TOPN, SUMMARIZECOLUMNS) over max_rows, which truncates only after the full result crossed the network. ' +
    'Limits: one query per request, 1,000,000 rows, 100,000 values, ~15 MB, throttled. Requires Build permission.',
  summary: 'Run a DAX query against a semantic model',
  icon: 'terminal',
  group: 'Datasets',
  input: z.object({
    dataset_id: z.string().min(1).describe('Semantic model (dataset) ID to query'),
    query: z
      .string()
      .min(1)
      .describe('The DAX query, starting with EVALUATE (e.g., "EVALUATE TOPN(10, \'SomeTable\')")'),
    max_rows: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Maximum rows to return (default ${DEFAULT_MAX_ROWS}). row_count always reports the true total.`),
  }),
  output: z.object({
    rows: z.array(daxRowSchema).describe('Result rows, keyed by bracketed column name'),
    columns: z
      .array(z.string())
      .describe('Column names, derived from the union of keys across all rows rather than from the first row'),
    row_count: z.number().int().describe('Total rows the model returned, before any truncation'),
    returned_row_count: z.number().int().describe('How many rows are present in "rows"'),
    truncated: z.boolean().describe('True when row_count exceeds returned_row_count because max_rows applied'),
    columns_consistent: z
      .boolean()
      .describe(
        'False when at least one row omitted a column the others carried. Treat the result as suspect and check inconsistent_columns.',
      ),
    inconsistent_columns: z
      .array(z.string())
      .describe('Columns missing from at least one row. Empty when columns_consistent is true.'),
  }),
  handle: async params => {
    const query = params.query.trim();
    if (!/^(?:define|evaluate)\b/i.test(query)) {
      throw ToolError.validation(
        'A DAX query must start with EVALUATE (optionally preceded by DEFINE). Table and column browsing is available through describe_dataset.',
      );
    }

    const result = await runDaxQuery(params.dataset_id, query);
    const maxRows = params.max_rows ?? DEFAULT_MAX_ROWS;
    const rows = result.rows.slice(0, maxRows);

    return {
      rows,
      columns: result.columns,
      row_count: result.rows.length,
      returned_row_count: rows.length,
      truncated: rows.length < result.rows.length,
      columns_consistent: result.columnsConsistent,
      inconsistent_columns: result.inconsistentColumns,
    };
  },
});
