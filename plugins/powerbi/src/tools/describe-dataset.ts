import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type DaxRow, runDaxQuery } from '../dax.js';

/**
 * Model introspection uses the `INFO.VIEW.*` DAX functions rather than the
 * `INFO.*` family. `INFO.TABLES()` and friends require elevated model
 * permissions and answer with an Analysis Services error for a caller who only
 * holds Build; the `INFO.VIEW.*` equivalents are the user-facing variants and
 * work with Build alone.
 *
 * Each query projects an explicit column list. That keeps the payload bounded
 * and deliberately leaves out `[Expression]`, which carries the full DAX body of
 * every measure — bulky, and closer to model internals than to the metadata a
 * caller needs to write a query.
 */

const TABLES_QUERY =
  'EVALUATE SELECTCOLUMNS(INFO.VIEW.TABLES(), "name", [Name], "description", [Description], "hidden", [IsHidden], "storage_mode", [StorageMode])';

const MEASURES_QUERY =
  'EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "name", [Name], "table", [Table], "folder", [DisplayFolder], "data_type", [DataType], "hidden", [IsHidden])';

const COLUMNS_QUERY =
  'EVALUATE SELECTCOLUMNS(INFO.VIEW.COLUMNS(), "name", [Name], "table", [Table], "data_type", [DataType], "folder", [DisplayFolder], "hidden", [IsHidden])';

/** Read a `SELECTCOLUMNS` alias, which the serializer returns bracketed. */
const field = (row: DaxRow, alias: string): string => {
  const value = row[`[${alias}]`];
  return value === null || value === undefined ? '' : String(value);
};

const flag = (row: DaxRow, alias: string): boolean => row[`[${alias}]`] === true;

const tableSchema = z.object({
  name: z.string().describe('Table name, as it must be written in a DAX query'),
  description: z.string().describe('Table description, empty when unset'),
  storage_mode: z.string().describe('Storage mode (e.g., "Import", "DirectQuery", "Dual"), empty when unset'),
  is_hidden: z.boolean().describe('True when the model hides the table from report authors'),
});

const measureSchema = z.object({
  name: z.string().describe('Measure name, referenced in DAX as [Name]'),
  table: z.string().describe('Table the measure belongs to'),
  display_folder: z.string().describe('Folder the model groups the measure under, empty when ungrouped'),
  data_type: z.string().describe('Measure data type, empty when unset'),
  is_hidden: z.boolean().describe('True when the model hides the measure from report authors'),
});

const columnSchema = z.object({
  name: z.string().describe('Column name, referenced in DAX as Table[Name]'),
  table: z.string().describe('Table the column belongs to'),
  data_type: z.string().describe('Column data type, empty when unset'),
  display_folder: z.string().describe('Folder the model groups the column under, empty when ungrouped'),
  is_hidden: z.boolean().describe('True when the model hides the column from report authors'),
});

const matches = (filter: string, ...fields: string[]): boolean =>
  filter === '' || fields.some(value => value.toLowerCase().includes(filter));

export const describeDataset = defineTool({
  name: 'describe_dataset',
  displayName: 'Describe Dataset',
  description:
    'List the tables, measures, and columns a Power BI semantic model exposes, so a DAX query can be written against real identifiers instead of guessed ones. Call this before execute_dax. ' +
    'Columns are omitted by default because a large model has thousands of them — set include_columns to true, ideally with a filter. ' +
    'A big model can return several hundred measures; "filter" narrows by name, table, or folder, and the *_count fields always report true totals before filtering. ' +
    'Requires Build permission on the model.',
  summary: "List a model's tables, measures, and columns",
  icon: 'list-tree',
  group: 'Datasets',
  input: z.object({
    dataset_id: z.string().min(1).describe('Semantic model (dataset) ID to describe'),
    filter: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter applied to names, table names, and display folders'),
    include_columns: z.boolean().optional().describe('Include the column inventory (default false)'),
    include_hidden: z.boolean().optional().describe('Include items the model marks hidden (default false)'),
  }),
  output: z.object({
    tables: z.array(tableSchema).describe('Tables in the model'),
    measures: z.array(measureSchema).describe('Measures in the model'),
    columns: z.array(columnSchema).describe('Columns in the model. Empty unless include_columns is true.'),
    table_count: z.number().int().describe('Total tables before filtering'),
    measure_count: z.number().int().describe('Total measures before filtering'),
    column_count: z.number().int().describe('Total columns before filtering, or 0 when include_columns is false'),
    warnings: z
      .array(z.string())
      .describe('Introspection queries that failed, if any. An empty array means everything was read.'),
  }),
  handle: async (params, context) => {
    const filter = (params.filter ?? '').toLowerCase();
    const includeHidden = params.include_hidden === true;
    const warnings: string[] = [];

    const read = async (label: string, query: string): Promise<DaxRow[]> => {
      try {
        return (await runDaxQuery(params.dataset_id, query)).rows;
      } catch (error) {
        warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    };

    context?.reportProgress({ progress: 0, total: 3, message: 'Reading tables…' });
    const tableRows = await read('tables', TABLES_QUERY);

    context?.reportProgress({ progress: 1, total: 3, message: 'Reading measures…' });
    const measureRows = await read('measures', MEASURES_QUERY);

    context?.reportProgress({ progress: 2, total: 3, message: 'Reading columns…' });
    const columnRows = params.include_columns === true ? await read('columns', COLUMNS_QUERY) : [];

    if (tableRows.length === 0 && measureRows.length === 0 && columnRows.length === 0) {
      throw ToolError.internal(
        `Could not read any model metadata for dataset ${params.dataset_id}. ${warnings.join(' ') || 'The model returned nothing.'}`,
      );
    }

    const visible = (rows: DaxRow[]) => (includeHidden ? rows : rows.filter(row => !flag(row, 'hidden')));

    return {
      tables: visible(tableRows)
        .filter(row => matches(filter, field(row, 'name')))
        .map(row => ({
          name: field(row, 'name'),
          description: field(row, 'description'),
          storage_mode: field(row, 'storage_mode'),
          is_hidden: flag(row, 'hidden'),
        })),
      measures: visible(measureRows)
        .filter(row => matches(filter, field(row, 'name'), field(row, 'table'), field(row, 'folder')))
        .map(row => ({
          name: field(row, 'name'),
          table: field(row, 'table'),
          display_folder: field(row, 'folder'),
          data_type: field(row, 'data_type'),
          is_hidden: flag(row, 'hidden'),
        })),
      columns: visible(columnRows)
        .filter(row => matches(filter, field(row, 'name'), field(row, 'table'), field(row, 'folder')))
        .map(row => ({
          name: field(row, 'name'),
          table: field(row, 'table'),
          data_type: field(row, 'data_type'),
          display_folder: field(row, 'folder'),
          is_hidden: flag(row, 'hidden'),
        })),
      table_count: tableRows.length,
      measure_count: measureRows.length,
      column_count: columnRows.length,
      warnings,
    };
  },
});
