import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { liveDocumentOutputSchema, readLiveDocument } from '../live-edit.js';

export const getLiveDocument = defineTool({
  name: 'get_live_document',
  displayName: 'Get Live Document',
  description:
    'Read the paragraphs of the document open in this tab exactly as they are in the editor right now, including ' +
    'edits anyone co-editing it has just made. Each paragraph comes with its 1-based index, style name, list level ' +
    'and whether it sits in a table. Use it before the live edit tools (replace_text_live, insert_paragraphs_live, ' +
    'delete_paragraph_live) to copy text verbatim and to pick paragraphs by index. The document must be open in ' +
    'the Word web editor in this tab.',
  summary: 'Read the open document as it is in the editor now',
  icon: 'file-text',
  group: 'Live editing',
  input: z.object({}),
  output: liveDocumentOutputSchema,
  handle: async () => readLiveDocument(),
});
