import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsAlignText, podsAlignTextOutputSchema } from '../pods-bridge.js';

export const alignText = defineTool({
  name: 'align_text',
  displayName: 'Align Text',
  description:
    'Set the horizontal alignment (left, center, right, or justify) of a paragraph on the open slide, targeting it ' +
    'by its exact current visible text — use `get_live_outline` to see the text. This writes into the live ' +
    'co-authoring session, so the change appears in the open editor within seconds. Only the alignment changes: the ' +
    'words, formatting, and layout are preserved. The deck must be open and active in the browser.',
  summary: 'Align a paragraph in the open deck (co-authoring)',
  icon: 'align-center',
  group: 'Slides',
  input: z.object({
    text: z
      .string()
      .min(1)
      .describe('The exact current visible text of the paragraph to align, e.g. "Q3 Revenue" or a slide title.'),
    alignment: z.enum(['left', 'center', 'right', 'justify']).describe('The horizontal alignment to apply.'),
  }),
  output: podsAlignTextOutputSchema,
  handle: async params => podsAlignText(params.text, params.alignment),
});
