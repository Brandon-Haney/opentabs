import {
  defineTool,
  MAX_LOCAL_FILE_BYTES,
  SAVE_FILE_PATH_FORMAT,
  saveLocalFile,
  ToolError,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiV2, downloadFile } from '../confluence-api.js';
import type { RawAttachment } from './schemas.js';

export const getAttachment = defineTool({
  name: 'get_attachment',
  displayName: 'Get Attachment',
  description:
    'Save a file attached to a Confluence page to a path on this computer, using the signed-in browser session. ' +
    'Takes the attachment ID that list_page_attachments reports. The file is written straight to save_to and ' +
    'never passes through the browser Downloads folder. To read a file without keeping it, save it to your ' +
    'temporary or scratch directory, parse it there, and delete it when done. Files over ' +
    `${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB are refused before download.`,
  summary: 'Save an attachment to a path',
  icon: 'file-down',
  group: 'Pages',
  input: z.object({
    attachment_id: z.string().min(1).describe('Attachment ID (from list_page_attachments, e.g. "att123456")'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .describe(
        'Absolute path to write the file to, including the file name — e.g. a file in your temporary directory. ' +
          'The folder must exist; an existing file at the path is overwritten.',
      ),
  }),
  output: z.object({
    id: z.string().describe('Attachment ID'),
    title: z.string().describe('Filename of the attachment'),
    media_type: z.string().describe('MIME type (e.g., "image/png", "application/pdf")'),
    file_size: z.number().describe('Size of the saved file in bytes'),
    page_id: z.string().describe('ID of the page the file is attached to, or empty if not attached to a page'),
    saved_to: z.string().describe('Path the file was written to'),
  }),
  handle: async (params, context) => {
    const attachment = await apiV2<RawAttachment>(`/attachments/${encodeURIComponent(params.attachment_id)}`);
    const title = attachment.title ?? '';
    const declaredSize = attachment.fileSize ?? 0;
    if (declaredSize > MAX_LOCAL_FILE_BYTES) {
      throw ToolError.validation(
        `"${title}" is ${(declaredSize / 1024 / 1024).toFixed(1)} MB; files saved in one call may be at most ` +
          `${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB.`,
      );
    }

    const downloadLink = attachment.downloadLink ?? attachment._links?.download;
    if (!downloadLink) throw ToolError.internal(`Confluence returned no download link for "${title}".`);

    const file = await downloadFile(downloadLink);
    saveLocalFile(context, params.save_to, file.contentBase64);
    return {
      id: attachment.id ?? params.attachment_id,
      title,
      media_type: attachment.mediaType ?? '',
      file_size: file.size,
      page_id: attachment.pageId ?? '',
      saved_to: params.save_to,
    };
  },
});
