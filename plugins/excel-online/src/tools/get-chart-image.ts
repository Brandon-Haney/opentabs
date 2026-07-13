import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';

export const getChartImage = defineTool({
  name: 'get_chart_image',
  displayName: 'Get Chart Image',
  description:
    'Render a chart to a PNG image and return it as a base64-encoded string. Optionally set the pixel width and height; when omitted, the chart is rendered at its natural size. Useful for previewing a chart or embedding it elsewhere.',
  summary: 'Render a chart to a base64 PNG',
  icon: 'file-image',
  group: 'Charts',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    chart: z.string().describe('Chart name or ID (e.g., "Chart 1")'),
    width: z.number().positive().optional().describe('Rendered width in pixels'),
    height: z.number().positive().optional().describe('Rendered height in pixels'),
    fitting_mode: z
      .enum(['Fit', 'FitAndCenter', 'Fill'])
      .optional()
      .describe('How the chart fits the requested dimensions (default "Fit")'),
  }),
  output: z.object({
    image_base64: z.string().describe('Base64-encoded PNG image data (no data-URI prefix)'),
    mime_type: z.string().describe('Image MIME type (always "image/png")'),
  }),
  handle: async params => {
    const base = `/worksheets('${encodeURIComponent(params.worksheet)}')/charts('${encodeURIComponent(params.chart)}')`;
    // The image() function only accepts arguments when they are provided; an
    // empty argument list (`image()`) is rejected, so fall back to the bare
    // `/image` segment when no sizing is requested.
    const args: string[] = [];
    if (params.width !== undefined) args.push(`width=${params.width}`);
    if (params.height !== undefined) args.push(`height=${params.height}`);
    if (params.fitting_mode !== undefined) args.push(`fittingMode='${params.fitting_mode}'`);
    const endpoint = args.length > 0 ? `${base}/image(${args.join(',')})` : `${base}/image`;

    const data = await workbookApi<{ value?: string }>(endpoint);
    return { image_base64: data.value ?? '', mime_type: 'image/png' };
  },
});
