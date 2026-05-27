import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, uploadPptx } from '../pptx-utils.js';
import { addImageToSlide } from '../slide-edit.js';

export const addImage = defineTool({
  name: 'add_image',
  displayName: 'Add Image',
  description:
    'Insert an image onto a slide. Accepts base64-encoded image bytes (with or without a data: URI prefix) and a format hint. ' +
    'Positions and sizes are in inches. Supported formats: png, jpeg, jpg, gif, bmp, tiff, svg. ' +
    'Returns the new picture shape id for follow-up edits via `update_shape`.',
  summary: 'Insert an image onto a slide',
  icon: 'image',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    base64: z.string().describe('Base64-encoded image bytes. Accepts raw base64 or a `data:image/...;base64,...` URI.'),
    format: z
      .enum(['png', 'jpeg', 'jpg', 'gif', 'bmp', 'tiff', 'svg'])
      .describe('Image format — determines the media file extension and content type'),
    x: z.number().describe('X offset from slide top-left in inches'),
    y: z.number().describe('Y offset from slide top-left in inches'),
    w: z.number().positive().describe('Width in inches'),
    h: z.number().positive().describe('Height in inches'),
    rotation: z.number().optional().describe('Rotation in degrees (clockwise)'),
    name: z.string().optional().describe('Optional shape name (defaults to "Picture N")'),
  }),
  output: z.object({
    new_shape_id: z.string().describe('The id of the newly created picture shape'),
  }),
  handle: async params => {
    if (!params.base64 || params.base64.length === 0) {
      throw ToolError.validation('base64 image data is required');
    }

    const entries = await downloadPptx(params.item_id);
    const { new_shape_id } = addImageToSlide(entries, params.slide_number, {
      base64: params.base64,
      format: params.format,
      x: params.x,
      y: params.y,
      w: params.w,
      h: params.h,
      rotation: params.rotation,
      name: params.name,
    });

    await uploadPptx(params.item_id, entries);
    return { new_shape_id };
  },
});
