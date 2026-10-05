import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveDeleteParagraph, liveDeleteParagraphOutputSchema } from '../live-edit.js';

export const deleteParagraphLive = defineTool({
  name: 'delete_paragraph_live',
  displayName: 'Delete Paragraph (Live)',
  description:
    'Delete one paragraph (its text and its line, bullet included) from the document open in this tab, while it ' +
    'stays open; the change appears in every open editor within seconds. Name it by `anchor` (its exact text, or ' +
    'text found in no other paragraph) or by its `index` from get_live_document, which is how to reach an empty ' +
    'paragraph. The last paragraph of a table cell or of the document cannot be deleted. Pass `dry_run: true` to ' +
    'build the edit without writing it.',
  summary: 'Delete a paragraph from the open document, live',
  icon: 'trash-2',
  group: 'Live editing',
  input: z.object({
    anchor: z
      .string()
      .min(1)
      .optional()
      .describe('Text naming the paragraph: its exact text, or text found in no other paragraph.'),
    index: z.number().int().min(1).optional().describe('The paragraph’s index from get_live_document.'),
    dry_run: z.boolean().optional().describe('Build and return the edit without writing it.'),
  }),
  output: liveDeleteParagraphOutputSchema,
  handle: async params => {
    if ((params.anchor === undefined) === (params.index === undefined)) {
      throw ToolError.validation('Pass exactly one of `anchor` or `index` to name the paragraph.');
    }
    return liveDeleteParagraph({ anchor: params.anchor, index: params.index }, params.dry_run ?? false);
  },
});
