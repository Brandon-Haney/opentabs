import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveReplaceText, liveReplaceTextOutputSchema } from '../live-edit.js';

export const replaceTextLive = defineTool({
  name: 'replace_text_live',
  displayName: 'Replace Text (Live)',
  description:
    'Replace text in the document open in this tab, while it stays open. The edit goes through the co-authoring ' +
    'session, so it appears in every open editor within seconds and keeps formatting: the new text takes the ' +
    'formatting of the text it replaces. Matching is exact and case-sensitive within one paragraph. By default ' +
    '`find` must occur exactly once (include enough surrounding words to make it unique), or pass `all: true` to ' +
    'replace every occurrence. To remove a whole paragraph, use delete_paragraph_live instead. Use ' +
    'get_live_document to copy the current text verbatim. Pass `dry_run: true` to build the edit without writing it.',
  summary: 'Replace text in the open document, live',
  icon: 'replace',
  group: 'Live editing',
  input: z.object({
    find: z.string().min(1).describe('The exact text to replace (case-sensitive, within one paragraph).'),
    replace: z.string().describe('The replacement text. Single line; an empty string removes the text.'),
    all: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one (default false).'),
    dry_run: z.boolean().optional().describe('Build and return the edit without writing it.'),
  }),
  output: liveReplaceTextOutputSchema,
  handle: async params => liveReplaceText(params.find, params.replace, params.all ?? false, params.dry_run ?? false),
});
