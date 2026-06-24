import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { uploadAttachment as uploadAttachmentApi } from '../wrike-api.js';

export const uploadAttachment = defineTool({
  name: 'upload_attachment',
  displayName: 'Upload Attachment',
  description:
    'Attach a file to a task by uploading its contents. The file content must be provided as a base64-encoded string (a `data:` URI prefix is accepted and stripped). Use list_attachments afterwards to confirm the file is attached. Suited to small files — large binaries are impractical to pass as base64.',
  summary: 'Upload and attach a file to a task',
  icon: 'upload',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id to attach the file to'),
    file_name: z.string().min(1).describe('The file name, including extension (e.g. "checklist.txt")'),
    content_base64: z.string().min(1).describe('The file content, base64-encoded. A data: URI prefix is accepted.'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the file was uploaded and attached'),
    attachment_id: z.string().describe('The id of the new attachment, or empty if the response omitted it'),
    file_name: z.string().describe('The uploaded file name'),
  }),
  handle: async params => {
    const taskId = Number(params.task_id);
    if (!Number.isFinite(taskId)) throw ToolError.validation(`Invalid task id: "${params.task_id}"`);

    const result = await uploadAttachmentApi(taskId, params.file_name, params.content_base64);
    const attachmentId = result.id !== undefined && result.id !== null ? String(result.id) : '';

    return { success: true, attachment_id: attachmentId, file_name: params.file_name };
  },
});
