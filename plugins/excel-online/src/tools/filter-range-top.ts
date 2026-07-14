import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { bridgeOutputSchema, ewaBridge } from '../bridge.js';

/** EWA `SetTop10Filter` `Type`: filter by a count of items or by a percentage. */
const MODE = { items: 1, percent: 2 } as const;

export const filterRangeTop = defineTool({
  name: 'filter_range_top',
  displayName: 'Filter Range (Top/Bottom N)',
  description:
    'Filter one column of a range that already has an AutoFilter (see toggle_range_autofilter) to its top or ' +
    'bottom N rows, either by a count of items or by a percentage. Set "direction" to top or bottom, "mode" to ' +
    'items or percent, and "count" to N (e.g. top 3 items, or bottom 20 percent). "column" is the zero-based ' +
    "column index within the range. Not available through the standard workbook API — driven through Excel's " +
    'internal service via the frame bridge.',
  summary: 'Filter a range column to its top/bottom N',
  icon: 'filter',
  group: 'Ranges',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('The range that has the AutoFilter, including the header row (e.g., "A1:D100")'),
    column: z
      .number()
      .int()
      .min(0)
      .describe('Zero-based column index within the range to filter (0 = first column of the range)'),
    direction: z.enum(['top', 'bottom']).describe('Keep the top or the bottom rows'),
    mode: z.enum(['items', 'percent']).describe('Interpret "count" as a number of items or a percentage'),
    count: z.number().int().positive().describe('N — the number of items or the percentage to keep'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const b = parseBoundedRange(params.address);
    const absoluteColumn = b.startCol + params.column + 1;
    return ewaBridge('SetTop10Filter', {
      parameters: {
        AnchorType: 0,
        AnchorValue1: -1,
        AnchorValue2: -1,
        ChartId: null,
        AdvancedFilter: false,
        Count: String(params.count),
        DataFieldId: null,
        DataSourceIndex: 0,
        FieldId: '0',
        FilterType: 'Sheet',
        IsPivotFilter: false,
        Location: {
          SheetName: params.worksheet,
          NamedObjectName: null,
          FirstRow: 1,
          FirstColumn: absoluteColumn,
          LastRow: 1,
          LastColumn: absoluteColumn,
        },
        MaxCount: 500,
        Property: null,
        SelectedFieldIndex: -1,
        Title: '',
        Top: params.direction === 'top',
        Type: MODE[params.mode],
      },
    });
  },
});
