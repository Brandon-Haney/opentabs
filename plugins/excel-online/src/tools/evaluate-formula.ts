import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath, workbookApi } from '../excel-api.js';

/**
 * Scratch cell the formula is evaluated in. Far outside any realistic used
 * range, so it neither reads nor disturbs real content.
 */
const SCRATCH_CELL = 'ZZ9999';

/** Shape Graph returns for a range, both when reading it and when writing to it. */
interface RangeEcho {
  values?: unknown[][];
  text?: string[][];
  valueTypes?: string[][];
}

export const evaluateFormula = defineTool({
  name: 'evaluate_formula',
  displayName: 'Evaluate Formula',
  description:
    'Evaluate a formula and return its computed result without leaving anything behind in the workbook. ' +
    'The formula is evaluated in the context of a worksheet, so relative references resolve against that sheet. ' +
    'A leading "=" is optional. Formula errors are returned as a value in "error" with result_type "Error" — they do not throw. ' +
    'If the formula cannot be evaluated at all, the tool raises an error rather than returning an empty result.',
  summary: 'Evaluate a formula and return the result',
  icon: 'calculator',
  group: 'Workbook',
  input: z.object({
    worksheet: z.string().describe('Worksheet name for formula context (e.g., "Sheet1")'),
    formula: z
      .string()
      .describe('Formula to evaluate (e.g., "=SUM(A1:A10)", "=AVERAGE(B2:B100)"). The leading "=" is optional.'),
  }),
  output: z.object({
    result: z
      .union([z.string(), z.number(), z.boolean()])
      .nullable()
      .describe('The computed value. Null when the formula evaluated to an error — see "error".'),
    result_type: z
      .string()
      .describe('Excel value type of the result: "Double", "String", "Boolean", "Error", or "Empty"'),
    text: z.string().describe('The result as Excel would display it, with number formatting applied'),
    error: z
      .string()
      .describe('The Excel error code (e.g., "#DIV/0!", "#NAME?") when the formula errored, otherwise an empty string'),
  }),
  handle: async params => {
    const formula = params.formula.startsWith('=') ? params.formula : `=${params.formula}`;
    const scratch = rangePath(params.worksheet, SCRATCH_CELL);

    // Writing the formula returns the range's post-write state, which already
    // carries the evaluated value and its type. Reading the cell back in a
    // second request is not just redundant, it is unreliable: a sessionless
    // write to a workbook that is open for coauthoring does not survive to the
    // next request, so the read intermittently sees an empty cell and the tool
    // used to report that empty cell as a legitimate blank result.
    let written: RangeEcho;
    try {
      written = await workbookApi<RangeEcho>(scratch, {
        method: 'PATCH',
        retryNonIdempotent: true,
        body: { formulas: [[formula]] },
      });
    } finally {
      // The write may or may not persist depending on coauthoring state, so
      // clear unconditionally rather than reasoning about which case applies.
      await workbookApi(`${scratch}/clear`, {
        method: 'POST',
        body: { applyTo: 'All' },
        retryNonIdempotent: true,
      }).catch(() => {});
    }

    const value = written.values?.[0]?.[0];
    const valueType = written.valueTypes?.[0]?.[0] ?? '';
    if (value === undefined || valueType === '') {
      throw ToolError.internal(`Excel accepted the formula but returned no value for it. Formula: ${formula}`);
    }

    const isError = valueType === 'Error';
    return {
      result: isError ? null : (value as string | number | boolean | null),
      result_type: valueType,
      text: written.text?.[0]?.[0] ?? String(value ?? ''),
      error: isError ? String(value) : '',
    };
  },
});
