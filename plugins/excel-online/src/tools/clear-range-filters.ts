import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest, worksheetPath } from '../workbook-rest.js';

export const clearRangeFilters = defineTool({
  name: 'clear_range_filters',
  displayName: 'Clear Filters',
  description:
    "Clear every filter criterion on a worksheet's range AutoFilter, like Data → Clear: all rows become visible " +
    'again and the filter arrows stay. For a table use clear_table_filters. Runs inside the open editing session.',
  summary: 'Show all rows again, keeping the filter arrows',
  icon: 'filter-x',
  group: 'Data',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
  }),
  output: bridgeOutputSchema,
  handle: async params => workbookRest('Post', `${worksheetPath(params.worksheet)}/autoFilter/clearCriteria`),
});
