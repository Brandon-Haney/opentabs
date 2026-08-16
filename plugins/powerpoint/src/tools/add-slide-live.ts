import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsAddSlide, podsAddSlideOutputSchema } from '../pods-bridge.js';

export const addSlideLive = defineTool({
  name: 'add_slide_live',
  displayName: 'Add Slide (Live)',
  description:
    'Insert a new slide into the deck while it is OPEN in the browser, via the live co-authoring channel — the ' +
    'only way to add a slide without closing the deck (Graph refuses writes under the co-authoring lock). The new ' +
    'slide is appended to the end, inheriting the master and layout of an existing slide and anchored after the ' +
    'deck’s current last slide. Pass `dry_run: true` to construct and return the revision WITHOUT writing it, for ' +
    'inspection. The deck must be open and active in the browser.',
  summary: 'Add a slide to the open deck (co-authoring)',
  icon: 'plus-square',
  group: 'Slides',
  input: z.object({
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it (for verification).'),
  }),
  output: podsAddSlideOutputSchema,
  handle: async params => podsAddSlide(params.dry_run ?? false),
});
