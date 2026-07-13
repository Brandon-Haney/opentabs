import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';
import type { RawChart } from './schemas.js';
import { chartSchema, mapChart } from './schemas.js';

export const updateChart = defineTool({
  name: 'update_chart',
  displayName: 'Update Chart',
  description:
    "Update a chart's title and position. Set the title text and visibility, and move or resize the chart by setting its top, left, height, and width (in points).",
  summary: 'Change a chart title, position, or size',
  icon: 'chart-column',
  group: 'Charts',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    chart: z.string().describe('Chart name or ID (e.g., "Chart 1")'),
    title: z.string().optional().describe('Chart title text'),
    title_visible: z.boolean().optional().describe('Whether the title is shown'),
    top: z.number().optional().describe('Distance from the top of the worksheet in points'),
    left: z.number().optional().describe('Distance from the left of the worksheet in points'),
    height: z.number().positive().optional().describe('Chart height in points'),
    width: z.number().positive().optional().describe('Chart width in points'),
  }),
  output: z.object({ chart: chartSchema }),
  handle: async params => {
    const base = `/worksheets('${encodeURIComponent(params.worksheet)}')/charts('${encodeURIComponent(params.chart)}')`;

    const titleBody: Record<string, unknown> = {};
    if (params.title !== undefined) titleBody.text = params.title;
    if (params.title_visible !== undefined) titleBody.visible = params.title_visible;

    const positionBody: Record<string, unknown> = {};
    if (params.top !== undefined) positionBody.top = params.top;
    if (params.left !== undefined) positionBody.left = params.left;
    if (params.height !== undefined) positionBody.height = params.height;
    if (params.width !== undefined) positionBody.width = params.width;

    if (Object.keys(titleBody).length === 0 && Object.keys(positionBody).length === 0) {
      throw ToolError.validation('Provide at least one of title, title_visible, top, left, height, or width.');
    }

    if (Object.keys(titleBody).length > 0) {
      await workbookApi(`${base}/title`, { method: 'PATCH', body: titleBody });
    }

    // The chart PATCH returns the updated chart entity; when only the title
    // changed, read the chart back so the response still reflects current state.
    const chart =
      Object.keys(positionBody).length > 0
        ? await workbookApi<RawChart>(base, { method: 'PATCH', body: positionBody })
        : await workbookApi<RawChart>(base);
    return { chart: mapChart(chart) };
  },
});
