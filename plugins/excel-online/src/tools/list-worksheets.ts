import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { hasGraphAuth, isSharePoint, sharepointGetWorksheetNames, workbookApi } from '../excel-api.js';
import type { GraphListResponse, RawWorksheet } from './schemas.js';
import { worksheetSchema, mapWorksheet } from './schemas.js';

export const listWorksheets = defineTool({
  name: 'list_worksheets',
  displayName: 'List Worksheets',
  description:
    'List all worksheets in the currently open Excel workbook. Returns worksheet names, IDs, positions, and visibility status.',
  summary: 'List all worksheets in the workbook',
  icon: 'layers',
  group: 'Worksheets',
  input: z.object({}),
  output: z.object({ worksheets: z.array(worksheetSchema) }),
  handle: async () => {
    if (isSharePoint() && !hasGraphAuth()) {
      const names = await sharepointGetWorksheetNames();
      return {
        worksheets: names.map((name, i) => ({
          id: name,
          name,
          position: i,
          visibility: 'Visible',
        })),
      };
    }
    const data = await workbookApi<GraphListResponse<RawWorksheet>>('/worksheets');
    return { worksheets: (data.value ?? []).map(mapWorksheet) };
  },
});
