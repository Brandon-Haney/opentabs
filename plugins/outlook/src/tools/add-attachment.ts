import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachmentInputSchema, attachToDraft } from '../attachments.js';

export const addAttachment = defineTool({
  name: 'add_attachment',
  displayName: 'Add Attachment',
  description:
    'Attach one or more files on this computer to an existing draft message (created by create_draft, or a ' +
    'reply/forward saved with draft set to true). Name each file by its absolute path; OpenTabs reads it from ' +
    'disk, up to 25 MB per call in total. Attachments can only be added to drafts — not to already-sent messages.',
  summary: 'Attach files to a draft',
  icon: 'paperclip',
  group: 'Messages',
  input: z.object({
    draft_id: z.string().min(1).describe('The draft message ID to attach the files to'),
    attachments: z.array(attachmentInputSchema).min(1).describe('The files to attach'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the files were attached'),
    attached_count: z.number().describe('Number of files attached'),
  }),
  handle: async (params, context) => {
    await attachToDraft(params.draft_id, params, context);
    return { success: true, attached_count: params.attachments.length };
  },
});
