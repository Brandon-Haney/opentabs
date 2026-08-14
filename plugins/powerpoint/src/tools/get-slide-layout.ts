import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, readSlideXml, requireSlideFile } from '../pptx-utils.js';
import { getSlideSize, parseSlideLayout, resolveInheritedGeometry } from '../slide-layout.js';
import { driveIdInput, slideLayoutSchema } from './schemas.js';

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
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number to inspect (1-indexed)'),
  }),
  output: z.object({
    layout: slideLayoutSchema.describe('Structured slide layout'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id, params.drive_id);
    const file = requireSlideFile(entries, params.slide_number);
    // Placeholders usually state no geometry of their own and take it from the
    // layout placeholder sharing their `idx`, so the inheritance chain is
    // resolved and supplied rather than reporting the zeroes on the slide.
    const layout = parseSlideLayout(
      readSlideXml(entries, file),
      params.slide_number,
      getSlideSize(entries),
      resolveInheritedGeometry(entries, file),
    );

    return { layout };
  },
});
