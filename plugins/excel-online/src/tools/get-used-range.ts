import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookCall } from '../workbook-rest.js';
import type { RawRange } from './schemas.js';
import { mapRange, rangeSchema } from './schemas.js';

export const getUsedRange = defineTool({
  name: 'get_used_range',
  displayName: 'Get Used Range',
  description:
    'Get the smallest range that encompasses all cells with data or formatting in a worksheet. Useful for discovering the extent of data in a sheet without knowing the exact range.',
  summary: 'Get the used range of a worksheet',
  icon: 'scan',
  group: 'Ranges',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
  }),
  output: z.object({ range: rangeSchema }),
  handle: async (params, context) => {
    const data = await workbookCall<RawRange>(
      context,
      'GET',
      `/worksheets('${encodeURIComponent(params.worksheet)}')/usedRange`,
    );
    return { range: mapRange(data) };
  },
});
