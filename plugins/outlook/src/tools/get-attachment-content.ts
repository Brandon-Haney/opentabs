import { defineTool, SAVE_FILE_PATH_FORMAT, saveLocalFile, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';
import type { RawAttachmentContent } from './schemas.js';

const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/csv',
  'application/javascript',
  'application/yaml',
]);

const TEXT_EXTENSIONS = [
  '.csv',
  '.json',
  '.xml',
  '.txt',
  '.md',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.js',
  '.ts',
  '.py',
  '.sh',
];

/** Whether an attachment is a text format whose content reads usefully inline. */
const isTextAttachment = (name: string, contentType: string): boolean =>
  contentType.startsWith('text/') ||
  contentType.includes('+json') ||
  contentType.includes('+xml') ||
  TEXT_CONTENT_TYPES.has(contentType) ||
  TEXT_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension));

export const getAttachmentContent = defineTool({
  name: 'get_attachment_content',
  displayName: 'Get Attachment Content',
  description:
    'Read an email attachment. Text files (plain text, CSV, HTML, JSON, XML) come back as decoded text. ' +
    'Any other file (PDF, Excel, Word, PowerPoint, images) requires save_to: the file is written straight to that ' +
    'path and never passes through the browser Downloads folder. To read such a file without keeping it, save it to ' +
    'your temporary or scratch directory, parse it there, and delete it when done.',
  summary: 'Read an attachment or save it to a path',
  icon: 'file-down',
  group: 'Messages',
  input: z.object({
    message_id: z.string().describe('The message ID'),
    attachment_id: z.string().describe('The attachment ID (from list_attachments)'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .optional()
      .describe(
        'Absolute path to write the attachment to, including the file name — e.g. a file in your temporary ' +
          'directory. The folder must exist; an existing file at the path is overwritten. Required for any ' +
          'attachment that is not a text file.',
      ),
  }),
  output: z.object({
    name: z.string().describe('File name'),
    content_type: z.string().describe('MIME type'),
    size: z.number().describe('Size in bytes'),
    content: z.string().optional().describe('Decoded text content — present when save_to was not given'),
    saved_to: z.string().optional().describe('Path the attachment was written to — present when save_to was given'),
  }),
  handle: async (params, context) => {
    const data = await api<RawAttachmentContent>(
      `/me/messages/${params.message_id}/attachments/${params.attachment_id}`,
      {
        query: { $select: 'id,name,contentType,size,isInline,contentBytes' },
      },
    );

    const name = data.name ?? '';
    const contentType = data.contentType ?? 'application/octet-stream';
    const size = data.size ?? 0;
    const contentBytes = data.contentBytes;

    if (!contentBytes) {
      throw ToolError.validation(
        `Attachment "${name}" has no file content — it is an attached email item or a link to a cloud file.`,
      );
    }

    if (params.save_to !== undefined) {
      saveLocalFile(context, params.save_to, contentBytes);
      return { name, content_type: contentType, size, saved_to: params.save_to };
    }

    if (!isTextAttachment(name, contentType)) {
      throw ToolError.validation(
        `Attachment "${name}" (${contentType}) is not a text file. Pass save_to with an absolute path in your ` +
          'temporary directory, read the file from there, and delete it when done.',
      );
    }

    const bytes = Uint8Array.from(atob(contentBytes), c => c.charCodeAt(0));
    return { name, content_type: contentType, size, content: new TextDecoder().decode(bytes) };
  },
});
