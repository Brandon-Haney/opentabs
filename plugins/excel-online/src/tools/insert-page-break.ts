import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { addressToEwaRange, bridgeOutputSchema, ewaBridge } from '../bridge.js';

/**
 * Build the `InsertPageBreak` options. A manual page break is inserted above and
 * to the left of the given cell (Excel's standard page-break anchor semantics).
 */
export const buildInsertPageBreakOptions = (worksheet: string, cell: string): Record<string, unknown> => {
  const range = addressToEwaRange(cell);
  return {
    sheetCell: { SheetName: worksheet, FirstRow: range.FirstRow, FirstColumn: range.FirstColumn },
  };
};

export const insertPageBreak = defineTool({
  name: 'insert_page_break',
  displayName: 'Insert Page Break',
  description:
    'Insert a manual page break at a cell — the break is placed above and to the left of the cell, so the ' +
    'cell starts a new printed page. Not available through the standard workbook API — driven through ' +
    "Excel's internal service via the frame bridge.",
  summary: 'Insert a manual page break at a cell',
  icon: 'scissors',
  group: 'Layout',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    cell: z.string().describe('Single cell in A1 notation where the page break begins (e.g., "A25")'),
  }),
  output: bridgeOutputSchema,
  handle: async params => ewaBridge('InsertPageBreak', buildInsertPageBreakOptions(params.worksheet, params.cell)),
});
