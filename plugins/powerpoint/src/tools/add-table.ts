import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, readSlideXml, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { addTableToSlide } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const addTable = defineTool({
  name: 'add_table',
  displayName: 'Add Table',
  description:
    'Add a table to a slide, filled with your data. Pass `data` as rows of cell text (row-major); the first row ' +
    'is treated as a header by default. The table is styled with a built-in PowerPoint table style, so it looks ' +
    'like a real table — fills, banding, and header emphasis — without any manual formatting. Column widths and ' +
    'row heights are divided evenly across the box you give; rows grow taller if their text needs it. Positions ' +
    'and sizes are in inches. Returns the new table shape id.',
  summary: 'Add a data-filled table to a slide',
  icon: 'table',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    x: z.number().describe('X offset from slide top-left in inches'),
    y: z.number().describe('Y offset from slide top-left in inches'),
    w: z.number().positive().describe('Total table width in inches'),
    h: z.number().positive().describe('Total table height in inches (rows grow taller if text needs more room)'),
    data: z
      .array(z.array(z.string()))
      .min(1)
      .describe('Rows of cell text, row-major. Ragged rows are padded to the widest row with empty cells.'),
    header_row: z.boolean().optional().describe('Style the first row as a header (bold, filled). Defaults to true.'),
    band_row: z.boolean().optional().describe('Shade alternate rows. Defaults to true.'),
    style: z
      .string()
      .optional()
      .describe(
        'Table style: "default" (a filled, banded accent style), "grid" (plain gridlines only), "none" (unstyled), ' +
          'or a literal built-in style GUID like "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}".',
      ),
    name: z.string().optional().describe('Optional shape name (defaults to "Table N")'),
  }),
  output: z.object({
    new_shape_id: z.string().describe('The id of the newly created table'),
    rows: z.number().int().describe('Number of rows in the table'),
    columns: z.number().int().describe('Number of columns in the table'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      const { xml, new_shape_id } = addTableToSlide(readSlideXml(entries, file), {
        x: params.x,
        y: params.y,
        w: params.w,
        h: params.h,
        data: params.data,
        headerRow: params.header_row,
        bandRow: params.band_row,
        style: params.style,
        name: params.name,
      });
      writeSlideXml(entries, file, xml);
      return { new_shape_id, rows: params.data.length, columns: Math.max(...params.data.map(r => r.length)) };
    }),
});
