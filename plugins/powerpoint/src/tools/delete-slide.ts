import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, getRelatedParts, getSlideList, requireSlideFile } from '../pptx-utils.js';
import { removeSlideFromPackage } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const deleteSlide = defineTool({
  name: 'delete_slide',
  displayName: 'Delete Slide',
  description:
    'Delete a slide from a PowerPoint presentation by number (1-indexed). Removes the slide part along with the ' +
    'parts only it owned (its relationships and any comments) and every reference to it, then saves.',
  summary: 'Remove a slide from a presentation',
  icon: 'trash-2',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number to delete (1-indexed)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the deletion succeeded'),
    remaining_slides: z.number().int().describe('Number of slides remaining after deletion'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const slideFile = requireSlideFile(entries, params.slide_number);
      const slideCount = getSlideList(entries).length;
      if (slideCount <= 1) {
        throw ToolError.validation('Cannot delete the only slide in a presentation');
      }

      // Resolve parts owned solely by this slide before its rels file is removed —
      // afterwards they are unreachable and would be left orphaned in the package.
      const ownedParts = getRelatedParts(entries, slideFile, '/relationships/comments');

      removeSlideFromPackage(entries, slideFile, ownedParts);
      return { success: true, remaining_slides: slideCount - 1 };
    }),
});
