import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge } from '../bridge.js';

/**
 * Build the `FreezeOrUnfreezePanes` options. `rows`/`columns` are the number of
 * leading rows/columns to freeze; both zero unfreezes. This payload shape is
 * proven live end-to-end against a real coauthoring session.
 */
export const buildFreezePanesOptions = (worksheet: string, rows: number, columns: number): Record<string, unknown> => ({
  freezeSettings: {
    SheetName: worksheet,
    Freeze: rows > 0 || columns > 0,
    FrozenRows: rows,
    FrozenColumns: columns,
    FirstRow: 0,
    FirstColumn: 0,
  },
});

export const freezePanes = defineTool({
  name: 'freeze_panes',
  displayName: 'Freeze Panes',
  description:
    'Freeze leading rows and/or columns of a worksheet so they stay visible while scrolling. Pass the ' +
    'number of rows and columns to keep frozen (e.g. rows=1 freezes the header row). Set both rows and ' +
    "columns to 0 to unfreeze. Not available through the standard workbook API — driven through Excel's " +
    'internal service via the frame bridge.',
  summary: 'Freeze or unfreeze rows and columns',
  icon: 'lock',
  group: 'View',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    rows: z.number().int().min(0).describe('Number of leading rows to freeze (0 to freeze no rows)'),
    columns: z.number().int().min(0).describe('Number of leading columns to freeze (0 to freeze no columns)'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge('FreezeOrUnfreezePanes', buildFreezePanesOptions(params.worksheet, params.rows, params.columns)),
});
