import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation } from '../pptx-utils.js';
import { addSlide as addSlideToDeck } from '../slide-edit.js';
import { driveIdInput } from './schemas.js';

export const addSlide = defineTool({
  name: 'add_slide',
  displayName: 'Add Slide',
  description:
    'Create a new slide from a slide layout, the same way the New Slide command does. The slide is built with one ' +
    'empty placeholder per slot the layout defines (title, body, and so on), each inheriting its position, size, ' +
    'and formatting from that layout — so the new slide matches the deck without anything being positioned by hand. ' +
    'Populate it with `update_shape` using a shape id from `get_slide_layout`. ' +
    'Use this rather than `duplicate_slide` when you want a clean slide instead of a copy of an existing one. ' +
    'By default the slide is appended and uses the layout of slide 1 — pass `insert_at` to place it elsewhere.',
  summary: 'Create a new slide from a layout',
  icon: 'plus-square',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    insert_at: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Position to insert the slide at (1-indexed). Omit to append to the end of the deck.'),
    layout_part: z
      .string()
      .optional()
      .describe(
        'Package path of the slide layout to build from, e.g. "ppt/slideLayouts/slideLayout2.xml". ' +
          'Omit to reuse the layout of slide 1.',
      ),
  }),
  output: z.object({
    new_slide_number: z.number().int().describe('Position of the new slide in the deck (1-indexed)'),
    total_slides: z.number().int().describe('Total number of slides after insertion'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries =>
      addSlideToDeck(entries, { layoutPart: params.layout_part, insertAt: params.insert_at }),
    ),
});
