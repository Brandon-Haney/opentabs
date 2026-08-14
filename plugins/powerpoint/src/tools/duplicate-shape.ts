import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, readSlideXml, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { duplicateShapeById } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

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
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    shape_id: z.string().describe('Shape id from get_slide_layout'),
    offset_x: z.number().optional().describe('Horizontal offset for the clone in inches (default 0.25)'),
    offset_y: z.number().optional().describe('Vertical offset for the clone in inches (default 0.25)'),
  }),
  output: z.object({
    new_shape_id: z.string().describe('The id of the newly created shape'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      const { xml, new_shape_id } = duplicateShapeById(readSlideXml(entries, file), params.shape_id, {
        offset_x: params.offset_x,
        offset_y: params.offset_y,
      });
      writeSlideXml(entries, file, xml);
      return { new_shape_id };
    }),
});
