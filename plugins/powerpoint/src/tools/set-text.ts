import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetText, podsSetTextOutputSchema } from '../pods-bridge.js';

export const setText = defineTool({
  name: 'set_text',
  displayName: 'Set Text',
  description:
    'Replace the text of a paragraph on the open slide, targeting it by its exact current visible text. The ' +
    'formatting (size, color, font, bold…) is preserved — only the words change. This writes into the live ' +
    'co-authoring session, so the change appears in the open editor within seconds; it edits the deck in place ' +
    'while it is open. The `text` must match one paragraph exactly (use `get_live_outline` to see the current ' +
    'text); paragraphs with mixed formatting (multiple runs) and multi-line replacements are not supported. ' +
    'Works on text that is really on a slide — an EMPTY placeholder’s prompt text ("Click to add title") cannot ' +
    'be filled this way; the server drops such writes. Pass `dry_run: true` to construct and return the revision ' +
    'without writing it. The deck must be open and active in the browser.',
  summary: 'Replace slide text by its current content, keeping the formatting',
  icon: 'pencil',
  group: 'Slides',
  input: z.object({
    text: z
      .string()
      .min(1)
      .describe('The exact current visible text of the paragraph to replace, e.g. "Q3 Revenue" or a slide title.'),
    new_text: z.string().describe('The replacement text. Single line; formatting is preserved.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it (for verification).'),
  }),
  output: podsSetTextOutputSchema,
  handle: async params => podsSetText(params.text, params.new_text, params.dry_run ?? false),
});
