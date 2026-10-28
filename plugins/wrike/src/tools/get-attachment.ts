import {
  defineTool,
  MAX_LOCAL_FILE_BYTES,
  SAVE_FILE_PATH_FORMAT,
  saveLocalFile,
  ToolError,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadAttachment, listTaskAttachments } from '../wrike-api.js';

export const getAttachment = defineTool({
  name: 'get_attachment',
  displayName: 'Get Attachment',
  description:
    'Save a file attached to a task to a path on this computer, using the signed-in Wrike session. Takes the ' +
    'task id and the attachment id that list_attachments reports, and saves the current version of the file. ' +
    'The file is written straight to save_to and never passes through the browser Downloads folder. To read a ' +
    'file without keeping it, save it to your temporary or scratch directory, parse it there, and delete it ' +
    `when done. Files over ${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB are refused before download.`,
  summary: 'Save a task attachment to a path',
  icon: 'file-down',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id the file is attached to'),
    attachment_id: z.string().min(1).describe('The attachment id (from list_attachments)'),
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
    id: z.string().describe('Attachment id'),
    name: z.string().describe('File name'),
    content_type: z.string().describe('MIME type Wrike served the file with, or empty if it sent none'),
    size: z.number().int().describe('Size of the saved file in bytes'),
    saved_to: z.string().describe('Path the file was written to'),
  }),
  handle: async (params, context) => {
    const taskId = Number(params.task_id);
    if (!Number.isFinite(taskId)) throw ToolError.validation(`Invalid task id: "${params.task_id}"`);

    const attachments = await listTaskAttachments(taskId);
    const attachment = attachments.find(raw => raw.id !== undefined && String(raw.id) === params.attachment_id);
    if (!attachment) {
      throw ToolError.notFound(
        `Task ${params.task_id} has no attachment with id ${params.attachment_id} — check the ids with list_attachments.`,
      );
    }

    const name = typeof attachment.title === 'string' ? attachment.title : '';
    const declaredSize = attachment.currentVersion?.fileSize ?? 0;
    if (declaredSize > MAX_LOCAL_FILE_BYTES) {
      throw ToolError.validation(
        `"${name}" is ${(declaredSize / 1024 / 1024).toFixed(1)} MB; files saved in one call may be at most ` +
          `${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB.`,
      );
    }

    const file = await downloadAttachment(params.attachment_id, name);
    saveLocalFile(context, params.save_to, file.contentBase64);
    return {
      id: params.attachment_id,
      name,
      content_type: file.contentType,
      size: file.size,
      saved_to: params.save_to,
    };
  },
});
