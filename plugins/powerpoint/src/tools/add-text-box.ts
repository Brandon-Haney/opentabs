import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { COLOR_INPUT_DESCRIPTION } from '../color.js';
import { editPresentation, readSlideXml, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { addTextBox as addTextBoxXml } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const addTextBox = defineTool({
  name: 'add_text_box',
  displayName: 'Add Text Box',
  description:
    'Add a new text box to a slide at the given position. Positions and sizes are in inches. ' +
    'Optional formatting controls font size, weight, color, font family, and alignment. ' +
    'Returns the new shape id, which can be passed to `update_shape` for further tweaks.',
  summary: 'Add a new text box to a slide',
  icon: 'text-cursor-input',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    text: z.string().describe('Text content. Use \\n for line breaks.'),
    x: z.number().describe('X offset from slide top-left in inches'),
    y: z.number().describe('Y offset from slide top-left in inches'),
    w: z.number().positive().describe('Width in inches'),
    h: z.number().positive().describe('Height in inches'),
    font_size: z.number().positive().optional().describe('Font size in points'),
    bold: z.boolean().optional().describe('Bold text'),
    italic: z.boolean().optional().describe('Italic text'),
    color: z.string().optional().describe(`Text color. ${COLOR_INPUT_DESCRIPTION}`),
    font: z.string().optional().describe('Font family name'),
    align: z.enum(['left', 'center', 'right', 'justify']).optional().describe('Horizontal alignment'),
    rotation: z.number().optional().describe('Rotation in degrees (clockwise)'),
  }),
  output: z.object({
    new_shape_id: z.string().describe('The id of the newly created text box'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      const { xml, new_shape_id } = addTextBoxXml(readSlideXml(entries, file), {
        text: params.text,
        x: params.x,
        y: params.y,
        w: params.w,
        h: params.h,
        font_size: params.font_size,
        bold: params.bold,
        italic: params.italic,
        color: params.color,
        font: params.font,
        align: params.align,
        rotation: params.rotation,
      });
      writeSlideXml(entries, file, xml);
      return { new_shape_id };
    }),
});
