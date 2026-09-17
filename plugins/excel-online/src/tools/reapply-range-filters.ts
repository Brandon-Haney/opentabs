import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest, worksheetPath } from '../workbook-rest.js';

export const reapplyRangeFilters = defineTool({
  name: 'reapply_range_filters',
  displayName: 'Reapply Filters',
  description:
    "Reapply a worksheet's range AutoFilter, like Data → Reapply. Use it after editing cells so rows that no " +
    'longer match the criteria are hidden and newly matching rows appear. Runs inside the open editing session.',
  summary: 'Reapply the current filter criteria',
  icon: 'filter',
  group: 'Data',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
  }),
  output: bridgeOutputSchema,
  handle: async params => workbookRest('Post', `${worksheetPath(params.worksheet)}/autoFilter/reapply`),
});
