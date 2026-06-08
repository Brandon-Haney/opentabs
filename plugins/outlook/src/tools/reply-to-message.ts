import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const replyToMessage = defineTool({
  name: 'reply_to_message',
  displayName: 'Reply to Message',
  description:
    'Reply to an email message. By default the reply is sent immediately. Set draft to true to instead save a threaded draft — with the original conversation quoted and reply headers set — to the Drafts folder for the user to review and send manually. Set reply_all to true to reply to all recipients.',
  summary: 'Reply to an email',
  icon: 'reply',
  group: 'Messages',
  input: z.object({
    message_id: z.string().describe('The message ID to reply to'),
    body: z.string().describe('Reply body content'),
    body_type: z
      .enum(['text', 'html'])
      .optional()
      .describe('Body content type (default: text). For drafts, html is inserted as-is above the quoted thread.'),
    reply_all: z.boolean().optional().describe('Reply to all recipients (default: false)'),
    draft: z.boolean().optional().describe('Save as a threaded draft instead of sending immediately (default: false)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation completed'),
    draft_id: z.string().optional().describe('Created draft message ID (only when draft is true)'),
    web_link: z.string().optional().describe('Link to open the draft in Outlook (only when draft is true)'),
  }),
  handle: async params => {
    if (params.draft) {
      // createReply/createReplyAll have the server build a draft in the Drafts
      // folder with the original conversation quoted, recipients pre-filled, and
      // reply headers set. The action takes no body, so the user's text is layered
      // on top of the returned quoted history with a follow-up PATCH (passing a
      // body to the create action would replace the quote and lose the thread).
      const draftAction = params.reply_all ? 'createReplyAll' : 'createReply';
      const draft = await api<{ id?: string; webLink?: string; body?: { content?: string } }>(
        `/me/messages/${params.message_id}/${draftAction}`,
        { method: 'POST' },
      );

      const userHtml = params.body_type === 'html' ? params.body : escapeHtml(params.body).replace(/\n/g, '<br>');
      const quoted = draft.body?.content ?? '';
      await api(`/me/messages/${draft.id}`, {
        method: 'PATCH',
        body: { body: { contentType: 'HTML', content: `<div>${userHtml}</div>${quoted}` } },
      });

      return { success: true, draft_id: draft.id ?? '', web_link: draft.webLink ?? '' };
    }

    const action = params.reply_all ? 'replyAll' : 'reply';
    await api(`/me/messages/${params.message_id}/${action}`, {
      method: 'POST',
      body:
        params.body_type === 'html'
          ? {
              message: {
                body: { contentType: 'HTML', content: params.body },
              },
            }
          : { comment: params.body },
    });
    return { success: true };
  },
});
