import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, getSlideList, TEXT_DECODER, TEXT_ENCODER, uploadPptx } from '../pptx-utils.js';
import { duplicateShapeById } from '../slide-edit.js';

export const duplicateShape = defineTool({
  name: 'duplicate_shape',
  displayName: 'Duplicate Shape',
  description:
    'Clone an existing shape on a slide. The copy is placed just below-right of the original with a small offset so it is visible. ' +
    'Returns the new shape id which can be passed to `update_shape` to customize it. ' +
    'Internal cNvPr ids are reassigned to avoid collisions.',
  summary: 'Clone a shape in place',
  icon: 'copy',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    shape_id: z.string().describe('Shape id from get_slide_layout'),
    offset_x: z.number().optional().describe('Horizontal offset for the clone in inches (default 0.25)'),
    offset_y: z.number().optional().describe('Vertical offset for the clone in inches (default 0.25)'),
  }),
  output: z.object({
    new_shape_id: z.string().describe('The id of the newly created shape'),
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
    const { xml, new_shape_id } = duplicateShapeById(slideXml, params.shape_id, {
      offset_x: params.offset_x,
      offset_y: params.offset_y,
    });
    entries.set(file, TEXT_ENCODER.encode(xml));

    await uploadPptx(params.item_id, entries);
    return { new_shape_id };
  },
});
