import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsDeleteSlide, podsDeleteSlideOutputSchema } from '../pods-bridge.js';

export const deleteSlideLive = defineTool({
  name: 'delete_slide_live',
  displayName: 'Delete Slide (Live)',
  description:
    'Delete a slide from the deck while it is OPEN in the browser, via the live co-authoring channel — the only ' +
    'way to remove a slide without closing the deck (Graph refuses writes under the co-authoring lock). Slides are ' +
    'addressed by `slide_index`, their 1-based position in the deck order. The target slide’s reference is removed ' +
    'from the deck; every other slide is preserved untouched. When deleting several slides, delete the ' +
    'highest-numbered first so the lower positions do not shift. Pass `dry_run: true` to construct the revision and ' +
    'return the ordered slide references WITHOUT writing, to confirm which slide index N addresses. The deck must be ' +
    'open and active in the browser.',
  summary: 'Delete a slide from the open deck (co-authoring)',
  icon: 'trash-2',
  group: 'Slides',
  input: z.object({
    slide_index: z.number().int().min(1).describe('1-based position of the slide to delete, in the deck order.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision (and the ordered slide refs) without writing it.'),
  }),
  output: podsDeleteSlideOutputSchema,
  handle: async params => podsDeleteSlide(params.slide_index, params.dry_run ?? false),
});
