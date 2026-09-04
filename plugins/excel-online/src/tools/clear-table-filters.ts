import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';

export const clearTableFilters = defineTool({
  name: 'clear_table_filters',
  displayName: 'Clear Table Filters',
  description:
    'Clear filters on a table, showing every previously hidden row. Pass "column" (header name or zero-based index) to clear only that column\'s filter; omit it to clear all filters on the table.',
  summary: 'Clear filters on a table',
  icon: 'filter-x',
  group: 'Tables',
  input: z.object({
    table: z.string().describe('Table name or ID'),
    column: z
      .union([z.string(), z.number().int().min(0)])
      .optional()
      .describe('Clear only this column (header name or zero-based index). Omit to clear all columns.'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the filters were cleared'),
  }),
  handle: async params => {
    const base = `/tables('${encodeURIComponent(params.table)}')`;
    if (params.column === undefined) {
      await workbookApi(`${base}/clearFilters`, { method: 'POST', body: {}, retryNonIdempotent: true });
      return { success: true };
    }
    const col =
      typeof params.column === 'number'
        ? `/columns/itemAt(index=${params.column})`
        : `/columns('${encodeURIComponent(params.column)}')`;
    await workbookApi(`${base}${col}/filter/clear`, { method: 'POST', body: {}, retryNonIdempotent: true });
    return { success: true };
  },
});
