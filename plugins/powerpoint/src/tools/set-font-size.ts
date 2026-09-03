import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetFontSize, podsSetFontSizeOutputSchema } from '../pods-bridge.js';

export const setFontSize = defineTool({
  name: 'set_font_size',
  displayName: 'Set Font Size',
  description:
    'Change the font size of text on the open slide. Name the paragraph with `text`, and optionally narrow the ' +
    'change to part of it with `match`, the way a person selects a few words before picking a size; without ' +
    '`match` the whole paragraph is resized and text outside a match keeps the size it had. This writes into the ' +
    'live co-authoring session, so the change appears in the open editor within a few seconds — it is the only way ' +
    'to edit a deck while it is open (Graph refuses writes under the co-authoring lock). Use `get_live_outline` to ' +
    'see the exact paragraph text. The deck must be open and active in the browser so the editor has an ' +
    'authenticated co-authoring session.',
  summary: 'Resize slide text, or part of it, by its visible content',
  icon: 'pencil',
  group: 'Slides',
  input: z.object({
    text: z
      .string()
      .min(1)
      .describe('The exact visible text of the paragraph to resize, e.g. "Workstream" or a slide title.'),
    match: z
      .string()
      .min(1)
      .optional()
      .describe('Resize only this part of the paragraph — a substring of `text`. Omit to resize the whole paragraph.'),
    occurrence: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Which occurrence of `match` to resize when it appears more than once, counting from 1. Defaults to the first.',
      ),
    size_pt: z.number().positive().describe('The new font size in points, e.g. 24.'),
  }),
  output: podsSetFontSizeOutputSchema,
  handle: async params =>
    podsSetFontSize(params.text, params.size_pt, { match: params.match, occurrence: params.occurrence }),
});
