import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, uploadPptx } from '../pptx-utils.js';
import { duplicateSlide as duplicateSlideInPlace } from '../slide-edit.js';

export const duplicateSlide = defineTool({
  name: 'duplicate_slide',
  displayName: 'Duplicate Slide',
  description:
    'Clone an existing slide. Copies the slide XML and its relationships (including an independent copy of any ' +
    'speaker notes) and registers the new slide in the presentation index. Use this to template new slides from ' +
    'existing ones. By default the clone is appended to the end of the deck — pass `insert_at` (1-indexed) to place ' +
    'it at a specific position.',
  summary: 'Clone an existing slide in place',
  icon: 'copy-plus',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    source_slide_number: z.number().int().min(1).describe('Slide number to duplicate (1-indexed)'),
    insert_at: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Position to insert the clone at (1-indexed). Omit to append to the end of the deck.'),
  }),
  output: z.object({
    new_slide_number: z.number().int().describe('Position of the new slide in the deck (1-indexed)'),
    total_slides: z.number().int().describe('Total number of slides after duplication'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id);
    const result = duplicateSlideInPlace(entries, params.source_slide_number, params.insert_at);
    await uploadPptx(params.item_id, entries);
    return result;
  },
});
