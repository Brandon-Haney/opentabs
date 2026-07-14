import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges, viewportSelection } from '../bridge.js';

/**
 * Data-validation rule kinds mapped to the EWA `CreateOrEditDataValidation`
 * `RuleType` (sent by name; decoded from the client bundle's
 * `DataValidationRuleType` enum). `list` shows an in-cell dropdown; the others
 * constrain the entry with an operator and one or two boundary values.
 */
const RULE_TYPES = {
  list: 'list',
  whole_number: 'wholeNumber',
  decimal: 'decimal',
  date: 'date',
  text_length: 'textLength',
} as const;

type RuleTypeKey = keyof typeof RULE_TYPES;

/**
 * Comparison operators mapped to the EWA `ConditionType` (OOXML data-validation
 * operator names). `between`/`not_between` use both boundaries; the rest use
 * only the first. `between` and `greater_than` are live-verified; the others
 * follow the same confirmed naming convention.
 */
const OPERATORS = {
  between: 'between',
  not_between: 'notBetween',
  equal: 'equal',
  not_equal: 'notEqual',
  greater_than: 'greaterThan',
  less_than: 'lessThan',
  greater_or_equal: 'greaterThanOrEqual',
  less_or_equal: 'lessThanOrEqual',
} as const;

type OperatorKey = keyof typeof OPERATORS;

/** Operators that require both a lower and an upper boundary. */
const TWO_BOUND: ReadonlySet<OperatorKey> = new Set(['between', 'not_between']);

export const addDataValidation = defineTool({
  name: 'add_data_validation',
  displayName: 'Add Data Validation',
  description:
    'Add a data-validation rule to a range. Use type "list" with "values" to create an in-cell dropdown of allowed ' +
    'choices. Use "whole_number", "decimal", "date", or "text_length" with an "operator" (between, not_between, ' +
    'equal, not_equal, greater_than, less_than, greater_or_equal, less_or_equal) and "value" (plus "value2" for ' +
    'between/not_between) to constrain entries. Optionally set "input_message" (prompt shown when the cell is ' +
    'selected) and "error_message" (alert shown on an invalid entry). Not available through the standard workbook ' +
    "API — driven through Excel's internal service via the frame bridge.",
  summary: 'Add a data-validation rule to a range',
  icon: 'circle-check',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range to validate in A1 notation (e.g., "F2:F100")'),
    type: z
      .enum(Object.keys(RULE_TYPES) as [RuleTypeKey, ...RuleTypeKey[]])
      .describe('Validation kind: list (dropdown), whole_number, decimal, date, or text_length'),
    values: z
      .array(z.union([z.string(), z.number()]))
      .optional()
      .describe('Allowed choices for a list dropdown (required when type is "list")'),
    operator: z
      .enum(Object.keys(OPERATORS) as [OperatorKey, ...OperatorKey[]])
      .optional()
      .describe('Comparison for non-list types (required unless type is "list")'),
    value: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Boundary value for the operator (the lower bound for between/not_between)'),
    value2: z.union([z.string(), z.number()]).optional().describe('Upper bound — required for between and not_between'),
    input_message: z.string().optional().describe('Prompt shown when a validated cell is selected'),
    error_message: z.string().optional().describe('Alert shown when an invalid value is entered'),
    ignore_blank: z.boolean().optional().describe('Allow blank cells (default true)'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const isList = params.type === 'list';
    let conditionType = 'between';
    let lowerBoundary = '';
    let upperBoundary = '';

    if (isList) {
      if (!params.values || params.values.length === 0) {
        throw ToolError.validation('A "list" validation requires "values" (the allowed choices).');
      }
      lowerBoundary = params.values.map(String).join(',');
    } else {
      if (params.operator === undefined) {
        throw ToolError.validation(`A "${params.type}" validation requires an "operator".`);
      }
      if (params.value === undefined) {
        throw ToolError.validation(`A "${params.type}" validation requires "value".`);
      }
      conditionType = OPERATORS[params.operator];
      lowerBoundary = String(params.value);
      if (TWO_BOUND.has(params.operator)) {
        if (params.value2 === undefined) {
          throw ToolError.validation(`The "${params.operator}" operator requires both "value" and "value2".`);
        }
        upperBoundary = String(params.value2);
      }
    }

    return ewaBridge(
      'CreateOrEditDataValidation',
      {
        selectedRanges: selectedRanges(params.worksheet, params.address),
        ruleOptions: {
          Command: 0,
          RuleType: RULE_TYPES[params.type],
          ConditionType: conditionType,
          IsIgnoreBlank: params.ignore_blank ?? true,
          IsInCellDropDown: isList,
          LowerBoundary: lowerBoundary,
          UpperBoundary: upperBoundary,
          IsAlertBlocking: true,
          IsShowErrorAlert: true,
          IsShowInputMessage: true,
          AlertTitle: '',
          AlertMessage: params.error_message ?? '',
          InputTitle: '',
          InputMessage: params.input_message ?? '',
          ShouldIgnoreFormulaError: false,
        },
      },
      { contextPatch: viewportSelection(params.worksheet, params.address) },
    );
  },
});
