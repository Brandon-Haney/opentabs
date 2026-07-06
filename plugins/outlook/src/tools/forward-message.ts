import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { composeBody } from '../compose-defaults.js';
import { api } from '../outlook-api.js';

export const forwardMessage = defineTool({
  name: 'forward_message',
  displayName: 'Forward Message',
  description:
    "Forward an email message to one or more recipients with an optional comment. By default the forward is sent immediately. Set draft to true to instead save a draft to the Drafts folder for the user to review and send manually. Either way the original message is quoted, recipients are pre-filled, and the user's default compose font and signature are applied automatically to the comment — do not write a signature into the comment yourself.",
  summary: 'Forward an email',
  icon: 'forward',
  group: 'Messages',
  input: z.object({
    message_id: z.string().describe('The message ID to forward'),
    to: z.array(z.string()).describe('Recipient email addresses'),
    comment: z.string().optional().describe('Optional comment to include above the forwarded message'),
    draft: z.boolean().optional().describe('Save as a draft instead of sending immediately (default: false)'),
    include_signature: z.boolean().optional().describe("Append the user's signature (default: true)"),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation completed'),
    draft_id: z.string().optional().describe('Created draft message ID (only when draft is true)'),
    web_link: z.string().optional().describe('Link to open the draft in Outlook (only when draft is true)'),
  }),
  handle: async params => {
    const toRecipients = params.to.map(addr => ({ emailAddress: { address: addr } }));

    // createForward produces a draft with the original message quoted and recipients
    // pre-filled. The comment — styled with the default font and signature — is layered
    // on top of the returned quoted body with a follow-up PATCH (passing a comment to
    // the create action inserts unstyled text). For an immediate forward the same
    // composed draft is then sent, keeping font/signature identical to the draft path.
    const draft = await api<{ id?: string; webLink?: string; body?: { content?: string } }>(
      `/me/messages/${params.message_id}/createForward`,
      { method: 'POST', body: { toRecipients } },
    );

    const composed = await composeBody({
      body: params.comment ?? '',
      bodyType: 'text',
      signature: params.include_signature === false ? 'none' : 'reply',
    });
    const quoted = draft.body?.content ?? '';
    await api(`/me/messages/${draft.id}`, {
      method: 'PATCH',
      body: { body: { contentType: 'HTML', content: `${composed.content}${quoted}` } },
    });

    if (params.draft) {
      return { success: true, draft_id: draft.id ?? '', web_link: draft.webLink ?? '' };
    }

    await api(`/me/messages/${draft.id}/send`, { method: 'POST' });
    return { success: true };
  },
});
