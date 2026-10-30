import {
  defineTool,
  MAX_LOCAL_FILE_BYTES,
  SAVE_FILE_PATH_FORMAT,
  saveLocalFile,
  ToolError,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachmentSchema, downloadAttachment, getAttachmentInfo } from '../attachments.js';

const MEGABYTE = 1024 * 1024;

export const getAttachment = defineTool({
  name: 'get_attachment',
  displayName: 'Get Attachment',
  description:
    'Save a file attached to a Jira issue to a path on this computer, using the signed-in browser session. Takes the attachment ID from the `attachments` that get_issue reports; an image shown in a description or comment as [image: <name>] is the attachment with that filename. The file is written straight to save_to and never passes through the browser Downloads folder. To read a file without keeping it, save it to your temporary or scratch directory, read it there, and delete it when done. ' +
    `Files over ${MAX_LOCAL_FILE_BYTES / MEGABYTE} MB are refused before download.`,
  summary: 'Save an attachment to a path',
  icon: 'file-down',
  group: 'Attachments',
  input: z.object({
    attachment_id: z.string().min(1).describe('Attachment ID (from the `attachments` that get_issue reports)'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .describe(
        'Absolute path to write the file to, including the file name — e.g. a file in your temporary directory. The folder must exist; an existing file at the path is overwritten.',
      ),
  }),
  output: z.object({
    attachment: attachmentSchema.describe('The saved attachment'),
    saved_to: z.string().describe('Path the file was written to'),
  }),
  handle: async (params, context) => {
    const attachment = await getAttachmentInfo(params.attachment_id);
    if (attachment.size > MAX_LOCAL_FILE_BYTES) {
      throw ToolError.validation(
        `"${attachment.filename}" is ${(attachment.size / MEGABYTE).toFixed(1)} MB; files saved in one call may be at most ${MAX_LOCAL_FILE_BYTES / MEGABYTE} MB.`,
      );
    }
    context?.reportProgress({ progress: 0, total: 1, message: `Downloading ${attachment.filename}` });
    saveLocalFile(context, params.save_to, await downloadAttachment(attachment));
    return { attachment, saved_to: params.save_to };
  },
});
