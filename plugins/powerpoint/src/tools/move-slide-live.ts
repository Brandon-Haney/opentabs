import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsMoveSlide, podsMoveSlideOutputSchema } from '../pods-bridge.js';

export const moveSlideLive = defineTool({
  name: 'move_slide_live',
  displayName: 'Move Slide (Live)',
  description:
    'Reorder a slide while the deck is OPEN in the browser, via the live co-authoring channel — the only way to ' +
    'move a slide without closing the deck (Graph refuses writes under the co-authoring lock). Slides are addressed ' +
    'by their 1-based position in the deck order: the slide at `from_index` is moved so it sits at `to_index` after ' +
    'the move. Every slide is preserved untouched — only the order changes. Pass `dry_run: true` to construct the ' +
    'revision and return the ordered slide references WITHOUT writing, to confirm which slide index N addresses. ' +
    'The deck must be open and active in the browser.',
  summary: 'Reorder a slide in the open deck (co-authoring)',
  icon: 'move-vertical',
  group: 'Slides',
  input: z.object({
    from_index: z.number().int().min(1).describe('1-based position of the slide to move, in the current deck order.'),
    to_index: z.number().int().min(1).describe('1-based position the slide occupies after the move.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision (and the ordered slide refs) without writing it.'),
  }),
  output: podsMoveSlideOutputSchema,
  handle: async params => podsMoveSlide(params.from_index, params.to_index, params.dry_run ?? false),
});
