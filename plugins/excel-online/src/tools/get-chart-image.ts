import {
  defineTool,
  MAX_LOCAL_FILE_BYTES,
  SAVE_FILE_PATH_FORMAT,
  saveLocalFile,
  ToolError,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookCall } from '../workbook-rest.js';

/** Number of bytes a base64 string decodes to. */
export const decodedBase64Size = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

/** The workbook path of a chart's `image` function, with sizing arguments only when any are given. */
export const buildChartImagePath = (
  worksheet: string,
  chart: string,
  sizing: { width?: number; height?: number; fittingMode?: string },
): string => {
  const base = `/worksheets('${encodeURIComponent(worksheet)}')/charts('${encodeURIComponent(chart)}')`;
  // The image() function rejects an empty argument list (`image()`), so a call
  // without sizing uses the bare `/image` segment.
  const args: string[] = [];
  if (sizing.width !== undefined) args.push(`width=${sizing.width}`);
  if (sizing.height !== undefined) args.push(`height=${sizing.height}`);
  if (sizing.fittingMode !== undefined) args.push(`fittingMode='${sizing.fittingMode}'`);
  return args.length > 0 ? `${base}/image(${args.join(',')})` : `${base}/image`;
};

export const getChartImage = defineTool({
  name: 'get_chart_image',
  displayName: 'Get Chart Image',
  description:
    'Render a chart to a PNG image and write it to save_to. The image never passes through the browser Downloads ' +
    'folder; open the saved file to view the chart. Optionally set the pixel width and height; when omitted, the ' +
    'chart is rendered at its natural size. To look at a chart without keeping it, save it to your temporary or ' +
    'scratch directory and delete it when done.',
  summary: 'Render a chart to a PNG file',
  icon: 'file-image',
  group: 'Charts',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    chart: z.string().describe('Chart name or ID (e.g., "Chart 1")'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .describe(
        'Absolute path to write the PNG to, including the file name (e.g. a .png file in your temporary ' +
          'directory). The folder must exist; an existing file at the path is overwritten.',
      ),
    width: z.number().positive().optional().describe('Rendered width in pixels'),
    height: z.number().positive().optional().describe('Rendered height in pixels'),
    fitting_mode: z
      .enum(['Fit', 'FitAndCenter', 'Fill'])
      .optional()
      .describe('How the chart fits the requested dimensions (default "Fit")'),
  }),
  output: z.object({
    saved_to: z.string().describe('Path the PNG was written to'),
    mime_type: z.string().describe('Image MIME type (always "image/png")'),
    size: z.number().describe('Image size in bytes'),
  }),
  handle: async (params, context) => {
    const endpoint = buildChartImagePath(params.worksheet, params.chart, {
      width: params.width,
      height: params.height,
      fittingMode: params.fitting_mode,
    });

    const data = await workbookCall<{ value?: string }>(context, 'GET', endpoint);
    const imageBase64 = data.value ?? '';
    if (imageBase64 === '') {
      throw ToolError.internal(`Excel returned no image for chart "${params.chart}".`);
    }
    const size = decodedBase64Size(imageBase64);
    if (size > MAX_LOCAL_FILE_BYTES) {
      throw ToolError.validation(
        `The rendered chart is ${(size / 1024 / 1024).toFixed(1)} MB; files saved in one call may be at most ` +
          `${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB. Request a smaller width and height.`,
      );
    }

    saveLocalFile(context, params.save_to, imageBase64);
    return { saved_to: params.save_to, mime_type: 'image/png', size };
  },
});
