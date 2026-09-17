import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest } from '../workbook-rest.js';

/** The `calculationMode` value each option maps to. */
export const CALCULATION_MODES = {
  automatic: 'Automatic',
  automatic_except_tables: 'AutomaticExceptTables',
  manual: 'Manual',
} as const;

export const setCalculationMode = defineTool({
  name: 'set_calculation_mode',
  displayName: 'Set Calculation Mode',
  description:
    'Set when the workbook recalculates, like Formulas → Calculation Options: automatic, automatic except data ' +
    'tables, or manual. In manual mode formulas update only when calculate_workbook runs. The response echoes the ' +
    'mode now in effect. Runs inside the open editing session.',
  summary: 'Switch automatic or manual calculation',
  icon: 'calculator',
  group: 'Formulas',
  input: z.object({
    mode: z.enum(['automatic', 'automatic_except_tables', 'manual']).describe('Calculation mode'),
  }),
  output: bridgeOutputSchema,
  handle: async params => workbookRest('Patch', 'application', { calculationMode: CALCULATION_MODES[params.mode] }),
});
