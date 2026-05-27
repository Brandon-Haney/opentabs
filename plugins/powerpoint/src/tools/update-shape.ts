import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, getSlideList, TEXT_DECODER, TEXT_ENCODER, uploadPptx } from '../pptx-utils.js';
import { editShapeFill, editShapeGeometry, editShapeText } from '../slide-edit.js';

export const updateShape = defineTool({
  name: 'update_shape',
  displayName: 'Update Shape',
  description:
    'Modify an existing shape on a slide — change its text, position, size, rotation, and/or solid fill color. ' +
    'Find the shape id via `get_slide_layout`. Any field you omit is left unchanged. ' +
    'Positions and sizes are in inches; rotation is in degrees (clockwise). ' +
    'Fill accepts a hex color like "FFCC00" or "#ffcc00" and cannot be applied to picture shapes.',
  summary: "Edit a shape's text, geometry, rotation, or fill",
  icon: 'move',
  group: 'Slides',
  input: z
    .object({
      item_id: z.string().describe('Item ID of the PowerPoint file'),
      slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
      shape_id: z.string().describe('Shape id from get_slide_layout'),
      text: z
        .string()
        .optional()
        .describe('New text content. Use \\n for line breaks. First-run formatting is preserved.'),
      x: z.number().optional().describe('New X offset in inches from slide top-left'),
      y: z.number().optional().describe('New Y offset in inches from slide top-left'),
      w: z.number().positive().optional().describe('New width in inches'),
      h: z.number().positive().optional().describe('New height in inches'),
      rotation: z.number().optional().describe('New rotation in degrees (clockwise)'),
      fill: z.string().optional().describe('Solid fill color as hex (e.g. "FFCC00" or "#ffcc00")'),
    })
    .refine(
      p =>
        p.text !== undefined ||
        p.x !== undefined ||
        p.y !== undefined ||
        p.w !== undefined ||
        p.h !== undefined ||
        p.rotation !== undefined ||
        p.fill !== undefined,
      { message: 'At least one of text, x, y, w, h, rotation, or fill must be provided' },
    ),
  output: z.object({
    success: z.boolean().describe('Whether the update succeeded'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id);
    const slideFiles = getSlideList(entries);

    if (params.slide_number > slideFiles.length || params.slide_number < 1) {
      throw ToolError.notFound(`Slide ${params.slide_number} not found — presentation has ${slideFiles.length} slides`);
    }

    const file = slideFiles[params.slide_number - 1];
    if (!file) throw ToolError.notFound(`Slide ${params.slide_number} not found`);
    const slideData = entries.get(file);
    if (!slideData) throw ToolError.internal(`Slide file not found in archive: ${file}`);

    let slideXml = TEXT_DECODER.decode(slideData);

    if (params.text !== undefined) {
      slideXml = editShapeText(slideXml, params.shape_id, params.text);
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

    entries.set(file, TEXT_ENCODER.encode(slideXml));
    await uploadPptx(params.item_id, entries);
    return { success: true };
  },
});
