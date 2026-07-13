import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { buildRangeAddress, parseBoundedRange } from '../a1.js';
import { workbookApi } from '../excel-api.js';
import type { RawTable } from './schemas.js';
import { mapTable, tableSchema } from './schemas.js';

export const insertTable = defineTool({
  name: 'insert_table',
  displayName: 'Insert Table',
  description:
    'Create a fully populated Excel table in one call: writes the header row and data rows starting at an anchor cell, converts them into a table, and applies an optional style, filter buttons, and total row. Use this instead of writing data and calling create_table separately.',
  summary: 'Write data and create a styled table in one call',
  icon: 'table',
  group: 'Tables',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Top-left anchor cell in A1 notation where the header row starts (e.g., "A1")'),
    headers: z.array(z.string()).min(1).describe('Column header labels (the first row of the table)'),
    rows: z
      .array(z.array(z.unknown()))
      .describe('Data rows. Each inner array is one row and must match the number of headers.'),
    style: z.string().optional().describe('Table style name (e.g., "TableStyleMedium9"); omit for the default style'),
    show_filter_button: z.boolean().optional().describe('Show filter dropdown buttons on the header row'),
    show_totals: z.boolean().optional().describe('Show a total row beneath the table'),
  }),
  output: z.object({ table: tableSchema, address: z.string().describe('The range the table occupies in A1 notation') }),
  handle: async params => {
    const width = params.headers.length;
    const badRow = params.rows.findIndex(row => row.length !== width);
    if (badRow !== -1) {
      throw ToolError.validation(
        `Row ${badRow} has ${params.rows[badRow]?.length ?? 0} values but there are ${width} headers — every row must match the header count.`,
      );
    }

    const anchor = parseBoundedRange(params.address);
    const fullAddress = buildRangeAddress({
      startRow: anchor.startRow,
      startCol: anchor.startCol,
      endRow: anchor.startRow + params.rows.length, // header row + data rows
      endCol: anchor.startCol + width - 1,
    });

    await workbookApi(`/worksheets('${encodeURIComponent(params.worksheet)}')/range(address='${fullAddress}')`, {
      method: 'PATCH',
      body: { values: [params.headers, ...params.rows] },
    });

    let table = await workbookApi<RawTable>('/tables/add', {
      method: 'POST',
      body: { address: `${params.worksheet}!${fullAddress}`, hasHeaders: true },
    });

    const patch: Record<string, unknown> = {};
    if (params.style !== undefined) patch.style = params.style;
    if (params.show_filter_button !== undefined) patch.showFilterButton = params.show_filter_button;
    if (params.show_totals !== undefined) patch.showTotals = params.show_totals;
    if (Object.keys(patch).length > 0 && table.id) {
      table = await workbookApi<RawTable>(`/tables('${encodeURIComponent(table.id)}')`, {
        method: 'PATCH',
        body: patch,
      });
    }

    return { table: mapTable(table), address: `${params.worksheet}!${fullAddress}` };
  },
});
