import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachmentSchema, localFilePath, readLocalFiles, uploadAttachments } from '../attachments.js';

export const addAttachment = defineTool({
  name: 'add_attachment',
  displayName: 'Add Attachment',
  description:
    "Attach files from this computer to a Jira issue. Files upload in order, one at a time; if one fails, the files before it stay attached. To show an image inside a comment instead, use add_comment's `images`.",
  summary: 'Attach files to an issue',
  icon: 'paperclip',
  group: 'Attachments',
  input: z.object({
    issue_key: z.string().describe('Issue key (e.g. "KAN-1") or issue ID'),
    paths: z
      .array(localFilePath('C:\\Users\\me\\Documents\\report.pdf'))
      .min(1)
      .describe('Files on this computer to attach, in order'),
  }),
  output: z.object({
    attachments: z.array(attachmentSchema).describe('The created attachments, in input order'),
  }),
  handle: async (params, context) => {
    const files = readLocalFiles(context, params.paths);
    return { attachments: await uploadAttachments(params.issue_key, files, context) };
  },
});
