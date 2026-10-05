import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveInsertParagraphs, liveInsertParagraphsOutputSchema } from '../live-edit.js';

export const insertParagraphsLive = defineTool({
  name: 'insert_paragraphs_live',
  displayName: 'Insert Paragraphs (Live)',
  description:
    'Insert one or more paragraphs before or after an existing paragraph of the document open in this tab, while ' +
    'it stays open; they appear in every open editor within seconds. Name the existing paragraph by `anchor` (its ' +
    'exact text, or text found in no other paragraph) or by its `index` from get_live_document. The new paragraphs ' +
    'take its style and list membership (after a bullet they are bullets at the same level, after a heading they ' +
    'are headings) and the character formatting of most of its text. Each list entry is one paragraph without line ' +
    'breaks. Pass `dry_run: true` to build the edit without writing it.',
  summary: 'Insert paragraphs into the open document, live',
  icon: 'text-cursor-input',
  group: 'Live editing',
  input: z.object({
    anchor: z
      .string()
      .min(1)
      .optional()
      .describe('Text naming the existing paragraph: its exact text, or text found in no other paragraph.'),
    index: z.number().int().min(1).optional().describe('The existing paragraph’s index from get_live_document.'),
    position: z.enum(['before', 'after']).optional().describe('Insert before or after it (default "after").'),
    paragraphs: z.array(z.string()).min(1).max(50).describe('The paragraphs to insert, in order.'),
    dry_run: z.boolean().optional().describe('Build and return the edit without writing it.'),
  }),
  output: liveInsertParagraphsOutputSchema,
  handle: async params => {
    if ((params.anchor === undefined) === (params.index === undefined)) {
      throw ToolError.validation('Pass exactly one of `anchor` or `index` to name the existing paragraph.');
    }
    return liveInsertParagraphs(
      { anchor: params.anchor, index: params.index },
      params.position ?? 'after',
      params.paragraphs,
      params.dry_run ?? false,
    );
  },
});
