import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { replaceTextInXml } from '../docx-utils.js';
import { downloadDocxEntries, uploadModifiedDocx } from './docx-edit-helpers.js';

export const replaceTextInDocument = defineTool({
  name: 'replace_text_in_document',
  displayName: 'Replace Text in Document',
  description:
    'Find and replace text in an existing Word document (.docx). This is the recommended way to edit documents because it preserves all formatting (bold, italic, headings, styles). Replaces every occurrence of the search text. The search is case-sensitive and exact, and a match must lie within one run: Word splits text into runs wherever formatting or a spelling mark changes, so a phrase crossing such a change is not found. For a document open in a tab, replace_text_live matches anywhere within a paragraph.',
  summary: 'Find and replace text in a Word document',
  icon: 'replace',
  group: 'Documents',
  input: z.object({
    item_id: z.string().describe('File ID of the .docx document'),
    find: z.string().min(1).describe('Text to search for (case-sensitive, exact match)'),
    replace: z.string().describe('Replacement text (use empty string to delete matches)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether replacements were made'),
    replacements: z.number().int().describe('Number of replacements made'),
  }),
  handle: async params => {
    const { entries, documentXml, documentXmlIndex, eTag } = await downloadDocxEntries(params.item_id);

    const { xml: newXml, count } = replaceTextInXml(documentXml, params.find, params.replace);

    if (count === 0) {
      throw ToolError.notFound(
        `Text "${params.find}" not found within one run of the document. If it crosses a change of formatting, ` +
          'replace a shorter part of it, or use replace_text_live on the document open in a tab.',
      );
    }

    await uploadModifiedDocx(params.item_id, entries, documentXmlIndex, newXml, eTag);

    return { success: true, replacements: count };
  },
});
