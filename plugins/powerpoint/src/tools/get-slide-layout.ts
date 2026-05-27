import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, getSlideList, TEXT_DECODER } from '../pptx-utils.js';
import { getSlideSize, parseSlideLayout } from '../slide-layout.js';
import { slideLayoutSchema } from './schemas.js';

export const getSlideLayout = defineTool({
  name: 'get_slide_layout',
  displayName: 'Get Slide Layout',
  description:
    'Return the full structural layout of a slide — every shape, text box, placeholder, picture, table, and chart — with position, size, rotation, fill color, and text formatting. ' +
    'All positions and sizes are in inches. Use this to understand what is on a slide before editing. ' +
    'Each shape has a stable `id` that future edit tools will use as a handle.',
  summary: 'Get the structural layout of a slide (shapes, positions, text, fill)',
  icon: 'layout-grid',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    slide_number: z.number().int().min(1).describe('Slide number to inspect (1-indexed)'),
  }),
  output: z.object({
    layout: slideLayoutSchema.describe('Structured slide layout'),
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
    const canvas = getSlideSize(entries);
    const layout = parseSlideLayout(slideXml, params.slide_number, canvas);

    return { layout };
  },
});
