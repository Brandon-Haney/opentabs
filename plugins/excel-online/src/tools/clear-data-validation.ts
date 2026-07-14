import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges, viewportSelection } from '../bridge.js';

export const clearDataValidation = defineTool({
  name: 'clear_data_validation',
  displayName: 'Clear Data Validation',
  description:
    'Remove any data-validation rule from a range, restoring free entry (including the in-cell dropdown a list ' +
    "rule adds). Not available through the standard workbook API — driven through Excel's internal service via the " +
    'frame bridge.',
  summary: 'Remove data validation from a range',
  icon: 'circle-x',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range to clear validation from in A1 notation (e.g., "F2:F100")'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge(
      'CreateOrEditDataValidation',
      {
        selectedRanges: selectedRanges(params.worksheet, params.address),
        // Command 1 is the dedicated clear op (Command 0 edits an existing rule
        // and is rejected by the edit-state guard); RuleType "anyValue" removes
        // the restriction.
        ruleOptions: {
          Command: 1,
          RuleType: 'anyValue',
          ConditionType: 'between',
          IsIgnoreBlank: true,
          IsInCellDropDown: false,
          LowerBoundary: '',
          UpperBoundary: '',
          IsAlertBlocking: true,
          IsShowErrorAlert: true,
          IsShowInputMessage: true,
          AlertTitle: '',
          AlertMessage: '',
          InputTitle: '',
          InputMessage: '',
          ShouldIgnoreFormulaError: false,
        },
      },
      {
        // Clearing edits an existing rule, so establish its edit-state with the
        // prep read first, and supply the selection the commit is scoped to.
        prep: {
          method: 'GetDataValidationSettings',
          options: { selectedRanges: selectedRanges(params.worksheet, params.address) },
        },
        contextPatch: viewportSelection(params.worksheet, params.address),
      },
    ),
});
