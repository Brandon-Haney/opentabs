import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';
import { hasPivotTableParts } from '../pivot-model.js';
import { fetchWorkbookPartNames } from '../workbook-package.js';
import type { GraphListResponse, RawTable } from './schemas.js';
import { mapTable, tableSchema } from './schemas.js';

export const listTables = defineTool({
  name: 'list_tables',
  displayName: 'List Tables',
  description:
    'List the Excel Tables in the workbook. Returns table names, IDs, and display settings. Optionally filter by worksheet name. ' +
    'This covers Excel Tables only — PivotTables are a different object and are never returned here, so an empty result does NOT mean the sheet is empty. ' +
    'When "pivot_tables_present" is true the workbook contains at least one PivotTable; call list_pivot_tables to see them.',
  summary: 'List Excel Tables, and flag whether PivotTables exist',
  icon: 'table',
  group: 'Tables',
  input: z.object({
    worksheet: z
      .string()
      .optional()
      .describe('Worksheet name to filter tables by. Omit to list tables from all sheets.'),
  }),
  output: z.object({
    tables: z.array(tableSchema).describe('Excel Tables matching the query'),
    pivot_tables_present: z
      .boolean()
      .describe(
        'True when the workbook contains at least one PivotTable anywhere. Workbook-scoped, not narrowed by the worksheet filter — use list_pivot_tables for per-sheet detail.',
      ),
  }),
  handle: async params => {
    const path = params.worksheet ? `/worksheets('${encodeURIComponent(params.worksheet)}')/tables` : '/tables';
    const [data, partNames] = await Promise.all([
      workbookApi<GraphListResponse<RawTable>>(path),
      fetchWorkbookPartNames(),
    ]);
    return {
      tables: (data.value ?? []).map(mapTable),
      pivot_tables_present: hasPivotTableParts(partNames),
    };
  },
});
