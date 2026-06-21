import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, getSlideList, replaceSlideText, TEXT_DECODER, TEXT_ENCODER, uploadPptx } from '../pptx-utils.js';

export const updateSlideText = defineTool({
  name: 'update_slide_text',
  displayName: 'Update Slide Text',
  description:
    "Replace the text of a slide's first (primary/title) text box, one paragraph per line. Use \\n to separate lines. " +
    'For precise control over a specific shape — including non-title text boxes — use `update_shape` with a shape id from `get_slide_layout` instead.',
  summary: 'Replace text in a slide’s primary text box',
  icon: 'pencil',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    text: z.string().describe('New text content for the slide (use \\n for line breaks)'),
  }),
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

    const slideXml = TEXT_DECODER.decode(slideData);
    const updatedXml = replaceSlideText(slideXml, params.text);
    entries.set(file, TEXT_ENCODER.encode(updatedXml));

    await uploadPptx(params.item_id, entries);
    return { success: true };
  },
});
