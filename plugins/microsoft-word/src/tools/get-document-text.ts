import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { readDocumentText } from '../docx-text.js';
import { extractZipEntry } from '../docx-utils.js';
import { downloadDocxBytes } from './docx-edit-helpers.js';

const commentSchema = z.object({
  id: z.string().describe('Comment id, as its [COMMENT id] anchor in the text shows it'),
  author: z.string().describe('Display name of the comment author'),
  date: z.string().describe('When the comment was written (ISO 8601), as Word stored it'),
  text: z.string().describe('Comment text'),
  resolved: z.boolean().describe('Whether the comment thread is marked resolved'),
  reply_to: z.string().nullable().describe('Id of the comment this one replies to, or null when it starts a thread'),
});

export const getDocumentText = defineTool({
  name: 'get_document_text',
  displayName: 'Get Document Text',
  description:
    "Read the saved text of a Word document (.docx) with the marks that change its meaning. Struck-through text reads as ~~text~~: authors often strike text to mark it removed, so treat it as no longer current. Tracked insertions read as {+text+} and tracked deletions as [-text-]. An image reads as [image: alt text or file name], and a text box as [text box: …]. [COMMENT id] marks where a comment's range starts; the comments, with their replies and whether they are resolved, are in `comments`. Headings start with one # per level, and each table row reads as | cell | cell |. `marks` counts each kind of mark, so check it before trusting the text as current.",
  summary: 'Read a Word document with strikethrough, tracked changes and comments',
  icon: 'file-text',
  group: 'Documents',
  input: z.object({
    item_id: z.string().describe('File ID of the .docx document (from list_children or search_files)'),
  }),
  output: z.object({
    paragraphs: z.array(z.string()).describe('Paragraphs and table rows, in document order, with their marks'),
    text: z.string().describe('Full document text with paragraphs joined by newlines'),
    comments: z.array(commentSchema).describe('Comments and replies, in the order the document stores them'),
    marks: z
      .object({
        struck: z.number().int().describe('Struck-through spans'),
        insertions: z.number().int().describe('Tracked insertions'),
        deletions: z.number().int().describe('Tracked deletions'),
        comments: z.number().int().describe('Comments, replies included'),
        images: z.number().int().describe('Images'),
      })
      .describe('How many of each mark the document carries'),
  }),
  handle: async params => {
    const { bytes } = await downloadDocxBytes(params.item_id);

    const document = await extractZipEntry(bytes, 'word/document.xml');
    if (!document) {
      throw ToolError.internal('Could not find word/document.xml in the .docx archive.');
    }

    const [comments, commentsExtended, relationships, styles] = await Promise.all([
      extractZipEntry(bytes, 'word/comments.xml'),
      extractZipEntry(bytes, 'word/commentsExtended.xml'),
      extractZipEntry(bytes, 'word/_rels/document.xml.rels'),
      extractZipEntry(bytes, 'word/styles.xml'),
    ]);
    const result = readDocumentText({ document, comments, commentsExtended, relationships, styles });
    return { ...result, text: result.paragraphs.join('\n') };
  },
});
