import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges } from '../bridge.js';

/**
 * Build the `SetPrintArea` options. `addToPrintArea: false` replaces any
 * existing print area; `true` appends the range to it.
 */
export const buildSetPrintAreaOptions = (
  worksheet: string,
  address: string,
  add: boolean,
): Record<string, unknown> => ({
  selectedRanges: selectedRanges(worksheet, address),
  addToPrintArea: add,
});

export const setPrintArea = defineTool({
  name: 'set_print_area',
  displayName: 'Set Print Area',
  description:
    'Define the print area of a worksheet — the range that prints and exports to PDF. By default this ' +
    'replaces any existing print area; set add=true to append the range to the current print area. Not ' +
    "available through the standard workbook API — driven through Excel's internal service via the frame bridge.",
  summary: 'Set or extend the worksheet print area',
  icon: 'printer',
  group: 'Layout',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation to set as the print area (e.g., "A1:F20")'),
    add: z.boolean().optional().describe('Append to the existing print area instead of replacing it (default false)'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge('SetPrintArea', buildSetPrintAreaOptions(params.worksheet, params.address, params.add ?? false)),
});
