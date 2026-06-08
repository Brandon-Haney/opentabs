import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';

export const forwardMessage = defineTool({
  name: 'forward_message',
  displayName: 'Forward Message',
  description:
    'Forward an email message to one or more recipients with an optional comment. By default the forward is sent immediately. Set draft to true to instead save a draft — with the original message quoted and recipients pre-filled — to the Drafts folder for the user to review and send manually.',
  summary: 'Forward an email',
  icon: 'forward',
  group: 'Messages',
  input: z.object({
    message_id: z.string().describe('The message ID to forward'),
    to: z.array(z.string()).describe('Recipient email addresses'),
    comment: z.string().optional().describe('Optional comment to include above the forwarded message'),
    draft: z.boolean().optional().describe('Save as a draft instead of sending immediately (default: false)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation completed'),
    draft_id: z.string().optional().describe('Created draft message ID (only when draft is true)'),
    web_link: z.string().optional().describe('Link to open the draft in Outlook (only when draft is true)'),
  }),
  handle: async params => {
    const toRecipients = params.to.map(addr => ({ emailAddress: { address: addr } }));

    if (params.draft) {
      // createForward produces a draft in the Drafts folder with the original
      // message quoted, recipients pre-filled, and the comment prepended above it.
      const draft = await api<{ id?: string; webLink?: string }>(`/me/messages/${params.message_id}/createForward`, {
        method: 'POST',
        body: { comment: params.comment ?? '', toRecipients },
      });
      return { success: true, draft_id: draft.id ?? '', web_link: draft.webLink ?? '' };
    }

    await api(`/me/messages/${params.message_id}/forward`, {
      method: 'POST',
      body: {
        comment: params.comment ?? '',
        toRecipients,
      },
    });
    return { success: true };
  },
});
