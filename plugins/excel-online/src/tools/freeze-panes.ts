import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge } from '../bridge.js';

/**
 * Build the `FreezeOrUnfreezePanes` options. `rows`/`columns` are the number of
 * leading rows/columns to freeze; both zero unfreezes.
 *
 * `FirstRow`/`FirstColumn` are the 0-based first row and column of the scrolling
 * pane. The editor sends its scroll position plus the frozen count there, so a
 * freeze anchored at A1 puts them equal to `rows`/`columns`. Sending 0 froze the
 * panes at the sheet's saved scroll position instead.
 */
export const buildFreezePanesOptions = (worksheet: string, rows: number, columns: number): Record<string, unknown> => ({
  freezeSettings: {
    SheetName: worksheet,
    Freeze: rows > 0 || columns > 0,
    FrozenRows: rows,
    FrozenColumns: columns,
    FirstRow: rows,
    FirstColumn: columns,
  },
});

/**
 * The context the editor sends with a Freeze Panes click: the target sheet named
 * and made active, and the call marked as a blocking UI operation. Without it the
 * service applies the freeze to whichever sheet the reused context had active
 * and answers success either way, so the named sheet stays unfrozen.
 */
export const buildFreezePanesContext = (worksheet: string, now: number): Record<string, unknown> => ({
  SheetName: worksheet,
  ViewportStateChange: {
    SheetViewportStateChanges: [
      {
        SheetName: worksheet,
        TopLeft: 'A1',
        SelectedRanges: {
          SheetName: worksheet,
          NamedObjectName: '',
          Ranges: [{ FirstRow: 0, FirstColumn: 0, LastRow: 0, LastColumn: 0 }],
        },
        ActiveCell: 'A1',
      },
    ],
    ActiveSheetName: worksheet,
  },
  BlockingUIOperation: true,
  BlockingUIOperationTimestamp: String(now),
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
    ewaBridge('FreezeOrUnfreezePanes', buildFreezePanesOptions(params.worksheet, params.rows, params.columns), {
      contextPatch: buildFreezePanesContext(params.worksheet, Date.now()),
    }),
});
