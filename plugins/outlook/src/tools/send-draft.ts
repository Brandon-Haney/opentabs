import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { requireDraft } from '../drafts.js';
import { api } from '../outlook-api.js';
import { emailAddressSchema, mapEmailAddress } from './schemas.js';

export const sendDraft = defineTool({
  name: 'send_draft',
  displayName: 'Send Draft',
  description:
    'Send an unsent draft exactly as it stands in the Drafts folder, including any edits or attachments the user ' +
    'made in Outlook, such as one made by create_draft or by reply_to_message / forward_message with draft set to ' +
    'true. The draft itself becomes the sent message, so no copy is left to clean up. The message is checked first ' +
    'and the call is refused unless it is still a draft with at least one recipient. Returns the subject and ' +
    'recipients it sent to — confirm them back to the user.',
  summary: 'Send an unsent draft',
  icon: 'send',
  group: 'Messages',
  input: z.object({
    draft_id: z.string().min(1).describe('ID of the draft to send (draft_id from the tool that created it)'),
  }),
  output: z.object({
    subject: z.string().describe('Subject of the sent message'),
    to: z.array(emailAddressSchema).describe('To recipients of the sent message'),
    cc: z.array(emailAddressSchema).describe('CC recipients of the sent message'),
    bcc: z.array(emailAddressSchema).describe('BCC recipients of the sent message'),
  }),
  handle: async params => {
    const draft = await requireDraft(params.draft_id, 'sent', ['toRecipients', 'ccRecipients', 'bccRecipients']);
    const to = (draft.toRecipients ?? []).map(mapEmailAddress);
    const cc = (draft.ccRecipients ?? []).map(mapEmailAddress);
    const bcc = (draft.bccRecipients ?? []).map(mapEmailAddress);
    if (to.length + cc.length + bcc.length === 0) {
      throw ToolError.validation(`Draft "${draft.subject ?? ''}" has no recipients, so it cannot be sent.`);
    }
    await api(`/me/messages/${params.draft_id}/send`, { method: 'POST' });
    return { subject: draft.subject ?? '', to, cc, bcc };
  },
});
