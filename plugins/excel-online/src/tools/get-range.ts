import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath, workbookApi } from '../excel-api.js';
import type { GraphListResponse, RawBorder, RawRange, RawRangeFormat } from './schemas.js';
import { mapRange, mapRangeFormat, rangeFormatSchema, rangeSchema } from './schemas.js';

export const getRange = defineTool({
  name: 'get_range',
  displayName: 'Get Range',
  description:
    'Get cell values, formulas, and formatting for a specific range in a worksheet. The range address uses A1 notation (e.g., "A1:C10"). Returns values, formulas, text, and number formats. Set include_format=true to also return visual formatting (fill, font, alignment, borders, dimensions) — format values are range-level, so a property that varies across the range reads as null.',
  summary: 'Read cell values from a range',
  icon: 'grid-3x3',
  group: 'Ranges',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation (e.g., "A1:C10", "B2", "A:D")'),
    include_format: z
      .boolean()
      .optional()
      .describe('Also return fill, font, alignment, borders, and dimensions (default false)'),
  }),
  output: z.object({
    range: rangeSchema,
    format: rangeFormatSchema.optional().describe('Visual formatting, present when include_format=true'),
  }),
  handle: async params => {
    const base = rangePath(params.worksheet, params.address);
    const data = await workbookApi<RawRange>(base);
    if (!params.include_format) return { range: mapRange(data) };
    const format = await workbookApi<RawRangeFormat>(`${base}/format`, {
      query: {
        $select: 'columnWidth,rowHeight,horizontalAlignment,verticalAlignment,wrapText',
        $expand: 'fill,font',
      },
    });
    const borders = await workbookApi<GraphListResponse<RawBorder>>(`${base}/format/borders`);
    return { range: mapRange(data), format: mapRangeFormat(format, borders.value ?? []) };
  },
});
