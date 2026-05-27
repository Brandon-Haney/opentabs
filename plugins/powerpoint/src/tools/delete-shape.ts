import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, getSlideList, TEXT_DECODER, TEXT_ENCODER, uploadPptx } from '../pptx-utils.js';
import { deleteShapeById } from '../slide-edit.js';

export const deleteShape = defineTool({
  name: 'delete_shape',
  displayName: 'Delete Shape',
  description:
    'Remove a shape from a slide. Find the shape id via `get_slide_layout`. ' +
    'Deleting a group removes all of its child shapes.',
  summary: 'Remove a shape from a slide',
  icon: 'trash-2',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    shape_id: z.string().describe('Shape id from get_slide_layout'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the deletion succeeded'),
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

    const slideXml = TEXT_DECODER.decode(slideData);
    const updated = deleteShapeById(slideXml, params.shape_id);
    entries.set(file, TEXT_ENCODER.encode(updated));

    await uploadPptx(params.item_id, entries);
    return { success: true };
  },
});
