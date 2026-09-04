import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { extractTextFromDocumentXml, extractZipEntry } from '../docx-utils.js';
import { downloadDocxBytes } from './docx-edit-helpers.js';

export const getDocumentText = defineTool({
  name: 'get_document_text',
  displayName: 'Get Document Text',
  description:
    'Extract plain text content from a Word document (.docx). Downloads the binary file, decompresses the OOXML archive, and extracts text from all paragraphs. Returns paragraphs as an array of strings.',
  summary: 'Extract text from a Word document',
  icon: 'file-text',
  group: 'Documents',
  input: z.object({
    item_id: z.string().describe('File ID of the .docx document (from list_children or search_files)'),
  }),
  output: z.object({
    paragraphs: z.array(z.string()).describe('Text paragraphs extracted from the document'),
    text: z.string().describe('Full document text with paragraphs joined by newlines'),
  }),
  handle: async params => {
    const { bytes } = await downloadDocxBytes(params.item_id);

    const xml = await extractZipEntry(bytes, 'word/document.xml');
    if (!xml) {
      throw ToolError.internal('Could not find word/document.xml in the .docx archive.');
    }

    const paragraphs = extractTextFromDocumentXml(xml);
    return {
      paragraphs,
      text: paragraphs.join('\n'),
    };
  },
});
