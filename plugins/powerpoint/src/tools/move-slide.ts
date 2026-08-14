import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation } from '../pptx-utils.js';
import { moveSlide as moveSlideInDeck } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const moveSlide = defineTool({
  name: 'move_slide',
  displayName: 'Move Slide',
  description:
    'Reorder a slide within the deck. Both positions are 1-indexed, and `to_position` is where the slide ends up ' +
    'after the move — so moving slide 5 to position 2 makes it the second slide. A position past the end of the deck ' +
    'moves the slide to the end. Nothing about the slide itself changes; only its place in the running order.',
  summary: 'Reorder a slide within the deck',
  icon: 'arrow-up-down',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    from_position: z.number().int().min(1).describe('Current position of the slide (1-indexed)'),
    to_position: z.number().int().min(1).describe('Position the slide should end up at (1-indexed)'),
  }),
  output: z.object({
    new_position: z.number().int().describe('Position the slide now occupies (1-indexed)'),
    total_slides: z.number().int().describe('Total slides in the deck'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries =>
      moveSlideInDeck(entries, params.from_position, params.to_position),
    ),
});
