import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { bridgeOutputSchema, ewaBridge } from '../bridge.js';

export const filterRangeColumn = defineTool({
  name: 'filter_range_column',
  displayName: 'Filter Range Column',
  description:
    'Filter one column of a range that already has an AutoFilter (see toggle_range_autofilter), keeping only rows ' +
    'whose value in that column matches one of "values". "column" is the zero-based column index within the range ' +
    "(0 = the range's first column). Values match the cell's displayed value and are compared as text, so pass " +
    'numbers as they appear (e.g. "120"). Filtering hides non-matching worksheet rows, like table filtering. Not ' +
    "available through the standard workbook API — driven through Excel's internal service via the frame bridge.",
  summary: 'Filter a column of a range AutoFilter by values',
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
    values: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .describe('Keep only rows whose column value matches one of these'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const b = parseBoundedRange(params.address);
    // FieldId is the column's index within the filter range; the internal
    // Location anchor uses the 1-based absolute column (range start + field + 1).
    const absoluteColumn = b.startCol + params.column + 1;
    return ewaBridge('ApplyFilterV2', {
      parameters: {
        Location: { SheetName: params.worksheet, NamedObjectName: '', FirstRow: 0, FirstColumn: absoluteColumn },
        FieldId: String(params.column),
        DataSourceIndex: -1,
        FilterType: 'Sheet',
        AnchorType: 0,
        ChartId: null,
        AnchorValue1: -1,
        AnchorValue2: -1,
      },
      checkedItems: params.values.map(v => `i${v}`),
      avoidDecodingItems: true,
    });
  },
});
