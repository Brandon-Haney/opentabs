import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsReadSlideLayout, podsReadSlideLayoutOutputSchema } from '../pods-bridge.js';

export const readSlideLayout = defineTool({
  name: 'read_slide_layout',
  displayName: 'Read Slide Layout',
  description:
    'Read where every shape on a slide of the OPEN deck sits: name, left, top, width and height in inches from the ' +
    'slide’s top-left corner (the slide is 13.333" × 7.5"), fill colour, and text. A table is listed with each row’s ' +
    'height and first-cell text, so a shape can be lined up with a row. Use it before `move_shape`, ' +
    '`resize_shape`, `duplicate_shape` or `set_table_height`, and after them to check the result. Reads the live ' +
    'co-authoring session, so it reflects edits made seconds ago.',
  summary: 'Read shape positions and sizes on a slide of the open deck',
  icon: 'layout-dashboard',
  group: 'Slides',
  input: z.object({
    slide: z.number().int().min(1).describe('The 1-based slide number.'),
  }),
  output: podsReadSlideLayoutOutputSchema,
  handle: async params => podsReadSlideLayout(params.slide),
});
