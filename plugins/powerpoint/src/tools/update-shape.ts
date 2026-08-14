import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { COLOR_INPUT_DESCRIPTION } from '../color.js';
import { editPresentation, readSlideXml, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { editShapeFill, editShapeGeometry, editShapeText, formatShapeText } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const updateShape = defineTool({
  name: 'update_shape',
  displayName: 'Update Shape',
  description:
    'Modify an existing shape on a slide — change its text, position, size, rotation, and/or solid fill color. ' +
    'Find the shape id via `get_slide_layout`. Any field you omit is left unchanged. ' +
    'Positions and sizes are in inches; rotation is in degrees (clockwise). ' +
    'Colors accept a theme name like "accent1" (preferred — it follows the deck template) or a hex like "FFCC00". ' +
    'Fill cannot be applied to picture shapes.',
  summary: "Edit a shape's text, geometry, rotation, or fill",
  icon: 'move',
  group: 'Slides',
  input: z
    .object({
      item_id: z.string().describe('Item ID of the PowerPoint file'),
      drive_id: driveIdInput,
      slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
      shape_id: z.string().describe('Shape id from get_slide_layout'),
      text: z
        .string()
        .optional()
        .describe(
          'New text content. Use \\n for line breaks, and prefix a line with tab characters to demote it to a ' +
            'deeper bullet level. First-run formatting is preserved.',
        ),
      x: z.number().optional().describe('New X offset in inches from slide top-left'),
      y: z.number().optional().describe('New Y offset in inches from slide top-left'),
      w: z.number().positive().optional().describe('New width in inches'),
      h: z.number().positive().optional().describe('New height in inches'),
      rotation: z.number().optional().describe('New rotation in degrees (clockwise)'),
      fill: z.string().optional().describe(`Solid fill color. ${COLOR_INPUT_DESCRIPTION}`),
      font_size: z
        .number()
        .positive()
        .optional()
        .describe('Font size in points for the text. Use this to fit text that overflows its box.'),
      bold: z.boolean().optional().describe('Bold text'),
      italic: z.boolean().optional().describe('Italic text'),
      text_color: z.string().optional().describe(`Text color. ${COLOR_INPUT_DESCRIPTION}`),
    })
    .refine(
      p =>
        p.text !== undefined ||
        p.x !== undefined ||
        p.y !== undefined ||
        p.w !== undefined ||
        p.h !== undefined ||
        p.rotation !== undefined ||
        p.fill !== undefined ||
        p.font_size !== undefined ||
        p.bold !== undefined ||
        p.italic !== undefined ||
        p.text_color !== undefined,
      {
        message:
          'At least one of text, x, y, w, h, rotation, fill, font_size, bold, italic, or text_color must be provided',
      },
    ),
  output: z.object({
    success: z.boolean().describe('Whether the update succeeded'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      let slideXml = readSlideXml(entries, file);

      const format =
        params.font_size !== undefined ||
        params.bold !== undefined ||
        params.italic !== undefined ||
        params.text_color !== undefined
          ? { fontSize: params.font_size, bold: params.bold, italic: params.italic, color: params.text_color }
          : undefined;

      if (params.text !== undefined) {
        slideXml = editShapeText(slideXml, params.shape_id, params.text, format);
      } else if (format) {
        // Formatting without new text reformats the runs already present.
        slideXml = formatShapeText(slideXml, params.shape_id, format);
      }
      if (
        params.x !== undefined ||
        params.y !== undefined ||
        params.w !== undefined ||
        params.h !== undefined ||
        params.rotation !== undefined
      ) {
        slideXml = editShapeGeometry(slideXml, params.shape_id, {
          x: params.x,
          y: params.y,
          w: params.w,
          h: params.h,
          rotation: params.rotation,
        });
      }
      if (params.fill !== undefined) {
        slideXml = editShapeFill(slideXml, params.shape_id, params.fill);
      }

      writeSlideXml(entries, file, slideXml);
      return { success: true };
    }),
});
