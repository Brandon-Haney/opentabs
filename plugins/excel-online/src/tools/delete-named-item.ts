import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest } from '../workbook-rest.js';

export const deleteNamedItem = defineTool({
  name: 'delete_named_item',
  displayName: 'Delete Named Item',
  description:
    'Delete a workbook-scoped name, like removing it in Formulas → Name Manager. Formulas that used the name show ' +
    '#NAME? afterwards. List names with list_named_items. Runs inside the open editing session.',
  summary: 'Delete a named range or constant',
  icon: 'trash-2',
  group: 'Formulas',
  input: z.object({
    name: z.string().min(1).describe('Name to delete (e.g., "TaxRate")'),
  }),
  output: bridgeOutputSchema,
  handle: async params => workbookRest('Delete', `names('${params.name.replace(/'/g, "''")}')`),
});
