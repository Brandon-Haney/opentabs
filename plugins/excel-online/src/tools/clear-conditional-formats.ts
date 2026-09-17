import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { rangePath, workbookRest } from '../workbook-rest.js';

export const clearConditionalFormats = defineTool({
  name: 'clear_conditional_formats',
  displayName: 'Clear Conditional Formatting',
  description:
    'Remove every conditional-formatting rule that touches a range, like Conditional Formatting → Clear Rules. ' +
    'A rule whose range overlaps the one given is removed in full, so pass the exact range whose rules should go. ' +
    'Cell fills and fonts applied by hand are not affected. Runs inside the open editing session.',
  summary: 'Remove conditional-formatting rules from a range',
  icon: 'eraser',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range whose rules to remove, in A1 notation (e.g., "A1:D20")'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    workbookRest('Post', `${rangePath(params.worksheet, params.address)}/conditionalFormats/clearAll`),
});
