import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookCall } from '../workbook-rest.js';
import type { GraphListResponse, RawChart } from './schemas.js';
import { chartSchema, mapChart } from './schemas.js';

export const listCharts = defineTool({
  name: 'list_charts',
  displayName: 'List Charts',
  description: 'List all charts in a worksheet. Returns chart names, IDs, dimensions, and positions.',
  summary: 'List all charts in a worksheet',
  icon: 'chart-bar',
  group: 'Charts',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
  }),
  output: z.object({ charts: z.array(chartSchema) }),
  handle: async (params, context) => {
    const data = await workbookCall<GraphListResponse<RawChart>>(
      context,
      'GET',
      `/worksheets('${encodeURIComponent(params.worksheet)}')/charts`,
    );
    return { charts: (data.value ?? []).map(mapChart) };
  },
});
