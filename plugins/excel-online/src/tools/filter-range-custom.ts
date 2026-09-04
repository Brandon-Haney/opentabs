import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { bridgeOutputSchema, ewaBridge } from '../bridge.js';

/**
 * Custom-filter comparison operators mapped to the EWA `SetCustomFilter`
 * `ActiveCompareType` code. Positive operators are even, their negations odd.
 * `equals` (0), `begins_with` (2), `ends_with` (4), `contains` (6),
 * `greater_than` (8), `greater_or_equal` (9), `less_than` (10), `less_or_equal`
 * (11), and `between` (12) are capture- or live-verified; the four negation
 * codes are each +1 of a verified code. `between`/`not_between` require both
 * `value` and `value2`.
 */
const OPERATORS = {
  equals: 0,
  not_equal: 1,
  begins_with: 2,
  does_not_begin_with: 3,
  ends_with: 4,
  does_not_end_with: 5,
  contains: 6,
  does_not_contain: 7,
  greater_than: 8,
  greater_or_equal: 9,
  less_than: 10,
  less_or_equal: 11,
  between: 12,
  not_between: 13,
} as const;

type Operator = keyof typeof OPERATORS;

const RANGE_OPERATORS: ReadonlySet<Operator> = new Set(['between', 'not_between']);

export const filterRangeCustom = defineTool({
  name: 'filter_range_custom',
  displayName: 'Filter Range (Custom)',
  description:
    'Filter one column of a range that already has an AutoFilter (see toggle_range_autofilter) by a custom ' +
    'comparison, keeping only matching rows. Operators: equals, not_equal, greater_than, greater_or_equal, ' +
    'less_than, less_or_equal, begins_with, does_not_begin_with, ends_with, does_not_end_with, contains, ' +
    'does_not_contain (all take one "value"), and between, not_between (take "value" as the lower bound and ' +
    '"value2" as the upper). "column" is the zero-based column index within the range. Not available through the ' +
    "standard workbook API — driven through Excel's internal service via the frame bridge.",
  summary: 'Filter a range column by a comparison',
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
    operator: z.enum(Object.keys(OPERATORS) as [Operator, ...Operator[]]).describe('Comparison operator'),
    value: z.union([z.string(), z.number()]).describe('Comparison value (the lower bound for between/not_between)'),
    value2: z.union([z.string(), z.number()]).optional().describe('Upper bound — required for between and not_between'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const needsValue2 = RANGE_OPERATORS.has(params.operator);
    if (needsValue2 && params.value2 === undefined) {
      throw ToolError.validation(`The "${params.operator}" operator requires both "value" and "value2".`);
    }

    const b = parseBoundedRange(params.address);
    const absoluteColumn = b.startCol + params.column + 1;
    return ewaBridge('SetCustomFilter', {
      parameters: {
        AnchorType: 0,
        AnchorValue1: -1,
        AnchorValue2: -1,
        ChartId: null,
        ActiveCompareType: OPERATORS[params.operator],
        ColumnName: '',
        ControlGroupOrder: 0,
        DataOrMemberPropertyId: null,
        DataSourceIndex: 0,
        EnabledWholeDays: false,
        FieldId: '0',
        FilterType: 'Sheet',
        IsPivotFilter: false,
        IsTimeSlicer: false,
        Location: {
          SheetName: params.worksheet,
          NamedObjectName: null,
          FirstRow: 1,
          FirstColumn: absoluteColumn,
          LastRow: 1,
          LastColumn: absoluteColumn,
        },
        MemberProperties: false,
        NonNumericCaptionFilteringEnabled: true,
        Property: null,
        SelectedFieldIndex: -1,
        ShowDataFields: false,
        ShowWholeDays: false,
        Value1: String(params.value),
        Value2: needsValue2 ? String(params.value2) : null,
        ValueTypeText: true,
        WholeDays: false,
      },
    });
  },
});
