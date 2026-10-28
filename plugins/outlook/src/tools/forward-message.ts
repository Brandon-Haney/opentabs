import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachmentInputSchema, attachToDraft, inlineImagesField, validateInlineImages } from '../attachments.js';
import {
  composeWithMentions,
  MENTION_HELP,
  resolvePeople,
  threadRecipients,
  unaddressedMentions,
} from '../mentions.js';
import { api } from '../outlook-api.js';

export const forwardMessage = defineTool({
  name: 'forward_message',
  displayName: 'Forward Message',
  description:
    "Forward an email message to one or more recipients with an optional body above the forwarded message. By default the forward is sent immediately. Set draft to true to instead save a draft to the Drafts folder for the user to review; send it once approved with send_draft. Either way the original message and its attachments are included, recipients are pre-filled, and the user's default compose font and signature are applied automatically to the body — do not write a signature into the body yourself. Supports plain text or HTML body, CC/BCC, importance level, file attachments and inline images.",
  summary: 'Forward an email',
  icon: 'forward',
  group: 'Messages',
  input: z.object({
    message_id: z.string().describe('The message ID to forward'),
    to: z.array(z.string()).describe('Recipient email addresses'),
    body: z.string().optional().describe(`Optional body to write above the forwarded message. ${MENTION_HELP}`),
    body_type: z
      .enum(['text', 'html'])
      .optional()
      .describe('Body content type (default: text). HTML is inserted as-is above the forwarded message.'),
    cc: z.array(z.string()).optional().describe('CC recipient email addresses'),
    bcc: z.array(z.string()).optional().describe('BCC recipient email addresses'),
    importance: z.enum(['low', 'normal', 'high']).optional().describe('Importance level (default: normal)'),
    draft: z.boolean().optional().describe('Save as a draft instead of sending immediately (default: false)'),
    include_signature: z.boolean().optional().describe("Append the user's signature (default: true)"),
    attachments: z.array(attachmentInputSchema).optional().describe('Additional files to attach to the forward'),
    inline_images: inlineImagesField,
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation completed'),
    draft_id: z.string().optional().describe('Created draft message ID (only when draft is true)'),
    web_link: z.string().optional().describe('Link to open the draft in Outlook (only when draft is true)'),
  }),
  handle: async (params, context) => {
    const body = params.body ?? '';
    validateInlineImages(body, params.body_type, params.inline_images);
    const toRecipients = (addrs: string[]) => addrs.map(addr => ({ emailAddress: { address: addr } }));

    // createForward produces a draft with the original message quoted and recipients
    // pre-filled. The body — styled with the default font and signature — is layered
    // on top of the returned quoted body with a follow-up PATCH (passing a comment to
    // the create action inserts unstyled text). For an immediate forward the same
    // composed draft is then sent, keeping font/signature identical to the draft path.
    const draft = await api<{ id?: string; webLink?: string; body?: { content?: string } }>(
      `/me/messages/${params.message_id}/createForward`,
      { method: 'POST', body: { toRecipients: toRecipients(params.to) } },
    );
    const draftId = draft.id;
    if (!draftId) throw ToolError.internal('Forward draft was created without a message id.');

    const quoted = draft.body?.content ?? '';
    const applyBody = async () => {
      const addressed = [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])];
      const { body: composed, mentioned } = await composeWithMentions(
        { body, body_type: params.body_type, include_signature: params.include_signature },
        'reply',
        async () => resolvePeople([...addressed, ...(await threadRecipients(params.message_id))]),
      );
      const to = [...params.to, ...unaddressedMentions(mentioned, addressed).map(person => person.address)];
      await api(`/me/messages/${draftId}`, {
        method: 'PATCH',
        body: {
          body: { contentType: 'HTML', content: `${composed.content}${quoted}` },
          toRecipients: toRecipients(to),
          ccRecipients: params.cc ? toRecipients(params.cc) : undefined,
          bccRecipients: params.bcc ? toRecipients(params.bcc) : undefined,
          importance: params.importance,
        },
      });
      await attachToDraft(draftId, params, context);
    };

    // Compose the body onto the created draft. Any failure here means nothing was
    // sent, so delete the draft rather than leave an orphan — for both draft mode and
    // immediate send.
    try {
      await applyBody();
    } catch (err) {
      await api(`/me/messages/${draftId}`, { method: 'DELETE' }).catch(() => {});
      throw err;
    }

    if (params.draft) {
      return { success: true, draft_id: draftId, web_link: draft.webLink ?? '' };
    }

    // A failure of the send itself is ambiguous (the message may already be on its
    // way), so the draft is left in place rather than risk deleting a sent message.
    await api(`/me/messages/${draftId}/send`, { method: 'POST' });
    return { success: true };
  },
});
