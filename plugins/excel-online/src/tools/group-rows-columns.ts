import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type RangeBounds, buildRangeAddress, columnToIndex } from '../a1.js';
import { boundsToEwaRange, bridgeOutputSchema, ewaBridge, viewportSelection } from '../bridge.js';

const COLUMN_SPAN_RE = /^[A-Za-z]{1,3}(:[A-Za-z]{1,3})?$/;
const ROW_SPAN_RE = /^\d+(:\d+)?$/;
/** A rows group spans every column (through XFD); a columns group spans every row. */
const LAST_COLUMN_INDEX = 16383;
const LAST_ROW_INDEX = 1048575;

/** Split a "start:end" span into its two ends, defaulting a single reference to both ends. */
const spanEnds = (span: string): [string, string] => {
  const parts = span.split(':');
  const start = parts[0] ?? '';
  return [start, parts[1] ?? start];
};

interface Axis {
  bounds: RangeBounds;
  isRows: boolean;
}

/** Resolve the row or column span into full-extent bounds and the axis flag the RPC expects. */
const resolveAxis = (rows: string | undefined, columns: string | undefined): Axis => {
  if ((rows === undefined) === (columns === undefined)) {
    throw ToolError.validation('Provide exactly one of "rows" or "columns".');
  }
  if (rows !== undefined) {
    if (!ROW_SPAN_RE.test(rows)) {
      throw ToolError.validation(`"${rows}" is not a row span. Use numbers like "3" or "3:5".`);
    }
    const [start, end] = spanEnds(rows);
    const first = Number.parseInt(start, 10) - 1;
    const last = Number.parseInt(end, 10) - 1;
    return {
      bounds: {
        startRow: Math.min(first, last),
        endRow: Math.max(first, last),
        startCol: 0,
        endCol: LAST_COLUMN_INDEX,
      },
      isRows: true,
    };
  }
  const span = columns ?? '';
  if (!COLUMN_SPAN_RE.test(span)) {
    throw ToolError.validation(`"${span}" is not a column span. Use letters like "C" or "C:D".`);
  }
  const [start, end] = spanEnds(span);
  const first = columnToIndex(start);
  const last = columnToIndex(end);
  return {
    bounds: { startRow: 0, endRow: LAST_ROW_INDEX, startCol: Math.min(first, last), endCol: Math.max(first, last) },
    isRows: false,
  };
};

export const groupRowsColumns = defineTool({
  name: 'group_rows_columns',
  displayName: 'Group Rows/Columns',
  description:
    'Group (or ungroup) a span of rows or columns into a collapsible outline. Provide exactly one of "rows" (a number ' +
    'span like "3:5") or "columns" (a letter span like "C:D"). Set "ungroup" to true to remove the grouping instead ' +
    "of adding it. Not available through the standard workbook API — driven through Excel's internal service via the " +
    'frame bridge.',
  summary: 'Group or ungroup rows or columns',
  icon: 'group',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    rows: z.string().optional().describe('Row span to group, in number notation (e.g., "3:5")'),
    columns: z.string().optional().describe('Column span to group, in letter notation (e.g., "C:D")'),
    ungroup: z.boolean().optional().describe('true to ungroup, false to group (default false)'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const { bounds, isRows } = resolveAxis(params.rows, params.columns);
    return ewaBridge(
      'GroupOrUngroupCells',
      {
        selectedRange: { SheetName: params.worksheet, NamedObjectName: '', ...boundsToEwaRange(bounds) },
        isGroup: !(params.ungroup ?? false),
        isRows,
      },
      { contextPatch: viewportSelection(params.worksheet, buildRangeAddress(bounds)) },
    );
  },
});
