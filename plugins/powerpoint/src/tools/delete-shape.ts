import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, readSlideXml, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { deleteShapeById } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

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
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    shape_id: z.string().describe('Shape id from get_slide_layout'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the deletion succeeded'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      writeSlideXml(entries, file, deleteShapeById(readSlideXml(entries, file), params.shape_id));
      return { success: true };
    }),
});
