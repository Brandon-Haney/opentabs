import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { readConnections, readPivotCaches, readPivotTables } from '../pivot-model.js';
import { fetchWorkbookPackage } from '../workbook-package.js';
import { pivotTableSchema } from './schemas.js';

export const listPivotTables = defineTool({
  name: 'list_pivot_tables',
  displayName: 'List PivotTables',
  description:
    'List the PivotTables in the workbook with their host worksheet, anchor range, and the fields in each zone (rows, columns, filters, values). ' +
    'PivotTables are invisible to list_tables — that tool covers only Excel Tables — so this is how you discover them. ' +
    'Each filter reports the member it is pinned to, which is worth checking: a filter hardcoded to a specific period keeps returning that period after the model rolls forward, with no error. ' +
    'For the measures and hierarchies a pivot could show but does not, use inspect_data_model.',
  summary: 'List PivotTables with their zones and pinned filters',
  icon: 'table-properties',
  group: 'Data Model',
  input: z.object({
    worksheet: z
      .string()
      .optional()
      .describe('Worksheet name to filter by. Omit to list PivotTables from every sheet.'),
  }),
  output: z.object({
    pivot_tables: z.array(pivotTableSchema).describe('Matching PivotTables'),
  }),
  handle: async params => {
    const pkg = await fetchWorkbookPackage();
    const connections = await readConnections(pkg);
    const caches = await readPivotCaches(pkg, connections);
    const tables = await readPivotTables(pkg, caches);

    const matching = params.worksheet ? tables.filter(table => table.worksheet === params.worksheet) : tables;

    return {
      pivot_tables: matching.map(table => ({
        name: table.name,
        worksheet: table.worksheet,
        anchor: table.anchor,
        cache_id: table.cacheId,
        connection_name: table.connectionName,
        rows: table.rows,
        columns: table.columns,
        filters: table.filters.map(filter => ({ caption: filter.caption, selected_member: filter.selectedMember })),
        values: table.values,
      })),
    };
  },
});
