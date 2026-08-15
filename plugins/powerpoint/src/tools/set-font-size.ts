import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetFontSize, podsSetFontSizeOutputSchema } from '../pods-bridge.js';

export const setFontSize = defineTool({
  name: 'set_font_size',
  displayName: 'Set Font Size',
  description:
    'Change the font size of text on the open slide, targeting it by its exact visible text. This writes into the ' +
    "live co-authoring session, so the change appears in the open editor within a few seconds — it is the only way " +
    'to edit a deck while it is open (Graph refuses writes under the co-authoring lock). The `text` must match one ' +
    "paragraph's visible text exactly; paragraphs with mixed formatting (multiple runs) are not yet supported. The " +
    'deck must be open and active in the browser so the editor has an authenticated co-authoring session.',
  summary: 'Resize slide text by its visible content',
  icon: 'pencil',
  group: 'Slides',
  input: z.object({
    text: z
      .string()
      .min(1)
      .describe('The exact visible text of the paragraph to resize, e.g. "Workstream" or a slide title.'),
    size_pt: z.number().positive().describe('The new font size in points, e.g. 24.'),
  }),
  output: podsSetFontSizeOutputSchema,
  handle: async params => podsSetFontSize(params.text, params.size_pt),
});
