import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveRemoveLink, liveRemoveLinkOutputSchema } from '../live-edit.js';

export const removeLinkLive = defineTool({
  name: 'remove_link_live',
  displayName: 'Remove Link (Live)',
  description:
    'Remove hyperlinks from the document open in this tab, while it stays open, as Remove Link does in Word: the ' +
    'text stays, and stops linking and stops looking like a link. Name the link by `find` (text it displays), ' +
    'and/or a paragraph by `anchor` or `index` from get_live_document; naming only a paragraph removes every link ' +
    'in it. Text formatted to look like a link without being one is not a link; clear it with format_text_live ' +
    '`clear: true`. Pass `dry_run: true` to see which links would be removed without writing.',
  summary: 'Remove links from the open document, live',
  icon: 'unlink',
  group: 'Live editing',
  input: z.object({
    find: z.string().min(1).optional().describe('Text the link displays (or part of it).'),
    anchor: z
      .string()
      .min(1)
      .optional()
      .describe('Text naming the paragraph the link is in: its exact text, or text found in no other paragraph.'),
    index: z.number().int().min(1).optional().describe('The paragraph’s index from get_live_document.'),
    dry_run: z.boolean().optional().describe('Report the links that would be removed without writing.'),
  }),
  output: liveRemoveLinkOutputSchema,
  handle: async params => {
    if (params.anchor !== undefined && params.index !== undefined) {
      throw ToolError.validation('Pass at most one of `anchor` or `index` to name the paragraph.');
    }
    if (params.find === undefined && params.anchor === undefined && params.index === undefined) {
      throw ToolError.validation('Pass `find` (the link text), or name a paragraph with `anchor` or `index`.');
    }
    return liveRemoveLink({ find: params.find, anchor: params.anchor, index: params.index }, params.dry_run ?? false);
  },
});
