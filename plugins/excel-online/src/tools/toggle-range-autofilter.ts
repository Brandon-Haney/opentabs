import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { bridgeOutputSchema, ewaBridge } from '../bridge.js';

export const toggleRangeAutofilter = defineTool({
  name: 'toggle_range_autofilter',
  displayName: 'Toggle Range AutoFilter',
  description:
    'Toggle the AutoFilter on a plain (non-table) range — adds the filter dropdown arrows if the range has none, ' +
    'or removes the AutoFilter (and any active filters) if it already has them. Excel allows one AutoFilter per ' +
    'worksheet. Once the dropdowns are on, filter a column with filter_range_column. This is the plain-range ' +
    'equivalent of table filtering (use filter_table for tables); it is not available through the standard ' +
    "workbook API and is driven through Excel's internal service via the frame bridge.",
  summary: 'Add or remove AutoFilter dropdowns on a range',
  icon: 'filter',
  group: 'Ranges',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z
      .string()
      .describe('Bounded range to toggle the AutoFilter on, including the header row (e.g., "A1:D100")'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const b = parseBoundedRange(params.address);
    return ewaBridge('ToggleAutoFilter', {
      filterRange: {
        SheetName: params.worksheet,
        NamedObjectName: '',
        FirstRow: b.startRow,
        LastRow: b.endRow,
        FirstColumn: b.startCol,
        LastColumn: b.endCol,
      },
    });
  },
});
