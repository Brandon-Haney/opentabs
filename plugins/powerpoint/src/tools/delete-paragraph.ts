import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsDeleteParagraph, podsDeleteParagraphOutputSchema } from '../pods-bridge.js';

export const deleteParagraph = defineTool({
  name: 'delete_paragraph',
  displayName: 'Delete Paragraph',
  description:
    'Remove one paragraph — a line or bullet — from a shape, table cell or the speaker notes of the open deck, leaving the ' +
    'paragraphs around it untouched. Name it with `text`: its exact visible text (use `get_live_outline`). The ' +
    'last paragraph in a shape or cell cannot be removed; replace its text with `set_text` instead. This writes ' +
    'into the live co-authoring session, so the line disappears from the open editor within a few seconds. These ' +
    'edits arrive as a co-author’s, so the editor’s own Undo cannot take them back — pass `dry_run: true` first ' +
    'to inspect the revision without writing it. The deck must be open and active in the browser.',
  summary: 'Remove a line of text from a shape on the open slide',
  icon: 'remove-formatting',
  group: 'Slides',
  input: z.object({
    text: z.string().min(1).describe('The exact visible text of the paragraph to remove.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked.'),
  }),
  output: podsDeleteParagraphOutputSchema,
  handle: async params => podsDeleteParagraph(params.text, params.dry_run ?? false),
});
