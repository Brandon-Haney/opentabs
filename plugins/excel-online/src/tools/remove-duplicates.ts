import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { bridgeOutputSchema, ewaBridge, viewportSelection } from '../bridge.js';

export const removeDuplicates = defineTool({
  name: 'remove_duplicates',
  displayName: 'Remove Duplicates',
  description:
    'Remove duplicate rows from a range, keeping the first occurrence of each unique combination. By default every ' +
    'column is compared; pass "key_columns" (zero-based indices within the range) to compare only some columns. Set ' +
    '"has_header" to false if the range has no header row (default true — the first row is preserved and not ' +
    "compared). Not available through the standard workbook API — driven through Excel's internal service via the " +
    'frame bridge.',
  summary: 'Remove duplicate rows from a range',
  icon: 'list-x',
  group: 'Ranges',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z
      .string()
      .describe('Bounded range to de-duplicate, including the header row if present (e.g., "A1:D100")'),
    has_header: z.boolean().optional().describe('Whether the first row is a header to preserve (default true)'),
    key_columns: z
      .array(z.number().int().min(0))
      .optional()
      .describe('Zero-based column indices within the range to compare when detecting duplicates (default: all)'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const bounds = parseBoundedRange(params.address);
    const hasHeader = params.has_header ?? true;
    const columnCount = bounds.endCol - bounds.startCol + 1;
    const keyColumns = params.key_columns ?? Array.from({ length: columnCount }, (_, i) => i);
    for (const column of keyColumns) {
      if (column >= columnCount) {
        throw ToolError.validation(
          `Key column ${column} is outside the range, which has ${columnCount} columns (indices 0-${columnCount - 1}).`,
        );
      }
    }

    return ewaBridge(
      'RemoveDuplicates',
      {
        removeDuplicatesInput: {
          HasHeader: hasHeader,
          Range: {
            SheetName: params.worksheet,
            NamedObjectName: '',
            // With a header the first row is preserved, so the compared range starts one row below it.
            FirstRow: hasHeader ? bounds.startRow + 1 : bounds.startRow,
            LastRow: bounds.endRow,
            FirstColumn: bounds.startCol,
            LastColumn: bounds.endCol,
          },
          KeyColumns: keyColumns,
        },
      },
      { contextPatch: viewportSelection(params.worksheet, params.address) },
    );
  },
});
