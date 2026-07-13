import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';
import type { RawTable } from './schemas.js';
import { mapTable, tableSchema } from './schemas.js';

export const createTable = defineTool({
  name: 'create_table',
  displayName: 'Create Table',
  description:
    'Create a new table from a data range. The range should contain the data (and optionally a header row). Set has_headers=true if the first row contains column headers. Optionally pick a style (e.g., "TableStyleMedium9") and hide the header filter buttons; use update_table for further style changes.',
  summary: 'Create a table from a data range',
  icon: 'table',
  group: 'Tables',
  input: z.object({
    address: z.string().describe('Range address containing the data (e.g., "Sheet1!A1:D10")'),
    has_headers: z.boolean().optional().describe('Whether the first row contains headers (default true)'),
    style: z.string().optional().describe('Table style name (e.g., "TableStyleMedium9"); omit for the default style'),
    show_filter_button: z.boolean().optional().describe('Show filter dropdown buttons on the header row'),
  }),
  output: z.object({ table: tableSchema }),
  handle: async params => {
    let data = await workbookApi<RawTable>('/tables/add', {
      method: 'POST',
      body: {
        address: params.address,
        hasHeaders: params.has_headers ?? true,
      },
    });
    if ((params.style !== undefined || params.show_filter_button !== undefined) && data.id) {
      const body: Record<string, unknown> = {};
      if (params.style !== undefined) body.style = params.style;
      if (params.show_filter_button !== undefined) body.showFilterButton = params.show_filter_button;
      data = await workbookApi<RawTable>(`/tables('${encodeURIComponent(data.id)}')`, { method: 'PATCH', body });
    }
    return { table: mapTable(data) };
  },
});
