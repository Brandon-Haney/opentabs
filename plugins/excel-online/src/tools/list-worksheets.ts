import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookRestCall } from '../workbook-rest.js';
import type { GraphListResponse, RawWorksheet } from './schemas.js';
import { mapWorksheet, worksheetSchema } from './schemas.js';

export const listWorksheets = defineTool({
  name: 'list_worksheets',
  displayName: 'List Worksheets',
  description:
    'List all worksheets in the currently open Excel workbook. Returns worksheet names, IDs, positions, and ' +
    'visibility status. Runs inside the open editing session.',
  summary: 'List all worksheets in the workbook',
  icon: 'layers',
  group: 'Worksheets',
  input: z.object({}),
  output: z.object({ worksheets: z.array(worksheetSchema) }),
  handle: async (_params, context) => {
    const data = await workbookRestCall<GraphListResponse<RawWorksheet>>(
      context,
      'Get',
      'worksheets?$select=id,name,position,visibility',
    );
    return { worksheets: (data?.value ?? []).map(mapWorksheet) };
  },
});
