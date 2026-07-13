import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';
import type { RawTable } from './schemas.js';
import { mapTable, tableSchema } from './schemas.js';

export const updateTable = defineTool({
  name: 'update_table',
  displayName: 'Update Table',
  description:
    'Update a table\'s style and display options: rename it, change its style (built-in names like "TableStyleLight1"–"TableStyleLight21", "TableStyleMedium1"–"TableStyleMedium28", "TableStyleDark1"–"TableStyleDark11"), or toggle the header row, total row, filter buttons, row/column banding, and first/last column emphasis.',
  summary: 'Change table style and display options',
  icon: 'table-properties',
  group: 'Tables',
  input: z.object({
    table: z.string().describe('Table name or ID'),
    new_name: z.string().optional().describe('New table name'),
    style: z.string().optional().describe('Table style name (e.g., "TableStyleMedium9")'),
    show_headers: z.boolean().optional().describe('Show the header row'),
    show_totals: z.boolean().optional().describe('Show the total row'),
    show_filter_button: z.boolean().optional().describe('Show filter dropdown buttons on the header row'),
    show_banded_rows: z.boolean().optional().describe('Show alternating row banding'),
    show_banded_columns: z.boolean().optional().describe('Show alternating column banding'),
    highlight_first_column: z.boolean().optional().describe('Emphasize the first column'),
    highlight_last_column: z.boolean().optional().describe('Emphasize the last column'),
  }),
  output: z.object({ table: tableSchema }),
  handle: async params => {
    const body: Record<string, unknown> = {};
    if (params.new_name !== undefined) body.name = params.new_name;
    if (params.style !== undefined) body.style = params.style;
    if (params.show_headers !== undefined) body.showHeaders = params.show_headers;
    if (params.show_totals !== undefined) body.showTotals = params.show_totals;
    if (params.show_filter_button !== undefined) body.showFilterButton = params.show_filter_button;
    if (params.show_banded_rows !== undefined) body.showBandedRows = params.show_banded_rows;
    if (params.show_banded_columns !== undefined) body.showBandedColumns = params.show_banded_columns;
    if (params.highlight_first_column !== undefined) body.highlightFirstColumn = params.highlight_first_column;
    if (params.highlight_last_column !== undefined) body.highlightLastColumn = params.highlight_last_column;
    if (Object.keys(body).length === 0) {
      throw ToolError.validation('Provide at least one property to update.');
    }
    const data = await workbookApi<RawTable>(`/tables('${encodeURIComponent(params.table)}')`, {
      method: 'PATCH',
      body,
    });
    return { table: mapTable(data) };
  },
});
