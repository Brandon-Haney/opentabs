import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsAddParagraph, podsAddParagraphOutputSchema } from '../pods-bridge.js';

export const addParagraph = defineTool({
  name: 'add_paragraph',
  displayName: 'Add Paragraph',
  description:
    'Append a new line of text to a shape on the open slide — the same thing a person does by clicking at the end ' +
    'of a line, pressing Enter, and typing. Name the paragraph to append after with `after` (its exact visible ' +
    'text) and the new line with `text`; the new paragraph inherits that paragraph’s formatting. Use ' +
    '`get_live_outline` to see the exact paragraph text, and call this once per line — `text` cannot contain line ' +
    'breaks. This writes into the live co-authoring session, so the line appears in the open editor within a few ' +
    'seconds; it edits the deck in place while it is open (Graph refuses writes under the co-authoring lock). These ' +
    'edits arrive as a co-author’s, so the editor’s own Undo cannot take them back — pass `dry_run: true` first to ' +
    'inspect the revisions without writing them. The deck must be open and active in the browser.',
  summary: 'Add a line of text to a shape on the open slide',
  icon: 'corner-down-left',
  group: 'Slides',
  input: z.object({
    after: z
      .string()
      .min(1)
      .describe(
        'The exact visible text of the paragraph to append after — normally the last line of the shape, e.g. a ' +
          'closing bullet. The new paragraph inherits its formatting.',
      ),
    text: z.string().min(1).describe('The text the new paragraph carries. Cannot contain line breaks.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revisions without writing them, so the change can be checked.'),
  }),
  output: podsAddParagraphOutputSchema,
  handle: async params => podsAddParagraph(params.after, params.text, params.dry_run ?? false),
});
