import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetSlideBackground, podsSetSlideBackgroundOutputSchema } from '../pods-bridge.js';

export const setSlideBackground = defineTool({
  name: 'set_slide_background',
  displayName: 'Set Slide Background',
  description:
    'Set a solid background colour on one slide while the deck is OPEN in the browser, via the live co-authoring ' +
    'channel. Slides are addressed by `slide_index`, their 1-based position in the deck order; `color_hex` is a ' +
    'six-digit RRGGBB colour (no leading #). Only the background fill changes — the slide’s content, layout, and ' +
    'theme are preserved untouched. Pass `dry_run: true` to construct the revision WITHOUT writing, for inspection. ' +
    'The deck must be open and active in the browser.',
  summary: 'Set a slide’s background colour in the open deck (co-authoring)',
  icon: 'paint-bucket',
  group: 'Slides',
  input: z.object({
    slide_index: z.number().int().min(1).describe('1-based position of the slide, in the deck order.'),
    color_hex: z
      .string()
      .regex(/^[0-9a-fA-F]{6}$/, 'six-digit RRGGBB colour, no leading #')
      .describe('The solid fill colour as six-digit RRGGBB (e.g. 4472C4).'),
    dry_run: z.boolean().optional().describe('When true, construct and return the revision without writing it.'),
  }),
  output: podsSetSlideBackgroundOutputSchema,
  handle: async params => podsSetSlideBackground(params.slide_index, params.color_hex, params.dry_run ?? false),
});
