import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { hasPivotTableParts } from '../pivot-model.js';
import { fetchWorkbookPartNames } from '../workbook-package.js';
import { workbookCall } from '../workbook-rest.js';
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
      .nullable()
      .describe(
        'True when the workbook contains at least one PivotTable anywhere. Workbook-scoped, not narrowed by the worksheet filter — use list_pivot_tables for per-sheet detail. Null when the check could not run, which says nothing either way.',
      ),
  }),
  handle: async (params, context) => {
    const path = params.worksheet ? `/worksheets('${encodeURIComponent(params.worksheet)}')/tables` : '/tables';
    // The tables come from the open session; the PivotTable check reads the saved
    // file through Graph, which a session can outlive (an expired token, or a
    // workbook Graph is refusing). Losing the flag should not lose the list, so
    // the check is allowed to fail on its own.
    const [data, partNames] = await Promise.all([
      workbookCall<GraphListResponse<RawTable>>(context, 'GET', path),
      fetchWorkbookPartNames().catch(() => null),
    ]);
    return {
      tables: (data.value ?? []).map(mapTable),
      pivot_tables_present: partNames === null ? null : hasPivotTableParts(partNames),
    };
  },
});
