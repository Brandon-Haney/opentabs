import {
  defineTool,
  MAX_LOCAL_FILE_BYTES,
  SAVE_FILE_PATH_FORMAT,
  saveLocalFile,
  ToolError,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachmentContent, attachmentMeta } from '../servicenow-api.js';
import { isSysId } from './schemas.js';

export const getAttachment = defineTool({
  name: 'get_attachment',
  displayName: 'Get Attachment',
  description:
    'Save a file attached to a ServiceNow record (an incident, change, request item, or any other table) to a ' +
    'path on this computer, using the signed-in browser session. Takes the attachment sys_id that ' +
    'list_incident_attachments reports. The file is written straight to save_to and never passes through the ' +
    'browser Downloads folder. To read a file without keeping it, save it to your temporary or scratch ' +
    `directory, parse it there, and delete it when done. Files over ${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB ` +
    'are refused before download.',
  summary: 'Save an attachment to a path',
  icon: 'file-down',
  group: 'Incidents',
  input: z.object({
    attachment: z.string().min(1).describe('The attachment sys_id (from list_incident_attachments)'),
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
    sys_id: z.string().describe('sys_id of the attachment'),
    file_name: z.string().describe('Original file name'),
    content_type: z.string().describe('MIME type (e.g., image/png, application/pdf)'),
    size_bytes: z.number().int().describe('Size of the saved file in bytes'),
    table_name: z.string().describe('Table of the record the file is attached to (e.g., incident)'),
    table_sys_id: z.string().describe('sys_id of the record the file is attached to'),
    saved_to: z.string().describe('Path the file was written to'),
  }),
  handle: async (params, context) => {
    const sysId = params.attachment.trim();
    if (!isSysId(sysId)) {
      throw ToolError.validation(`"${sysId}" is not an attachment sys_id — pass the 32-character sys_id.`);
    }

    const meta = await attachmentMeta(sysId);
    const fileName = meta.file_name ?? '';
    const declaredSize = Number(meta.size_bytes ?? '0');
    if (declaredSize > MAX_LOCAL_FILE_BYTES) {
      throw ToolError.validation(
        `"${fileName}" is ${(declaredSize / 1024 / 1024).toFixed(1)} MB; files saved in one call may be at most ` +
          `${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB.`,
      );
    }

    const file = await attachmentContent(sysId);
    saveLocalFile(context, params.save_to, file.contentBase64);
    return {
      sys_id: sysId,
      file_name: fileName,
      content_type: meta.content_type ?? '',
      size_bytes: file.size,
      table_name: meta.table_name ?? '',
      table_sys_id: meta.table_sys_id ?? '',
      saved_to: params.save_to,
    };
  },
});
