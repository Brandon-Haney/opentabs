import { ToolError } from '@opentabs-dev/plugin-sdk';
import { escapeHtml } from './markdown-html.js';
import { messagePreview } from './message-preview.js';
import { chatApi } from './teams-api.js';
import { extractMri, type RawMessage } from './tools/schemas.js';

/**
 * Quoted replies. Teams' Reply in a chat posts a new message that opens with a
 * quote card of the message it answers: a `<blockquote>` typed
 * `http://schema.skype.com/Reply` whose `itemid` is the original message's id,
 * naming its author by MRI and carrying a plain-text preview. The `qtdMsgs`
 * property names the same message again, and is what lets Teams verify the
 * card and link it back to the original.
 */

const REPLY_TYPE = 'http://schema.skype.com/Reply';

/** The quote card that opens a reply to `message`. */
export const replyQuoteHtml = (message: RawMessage): string => {
  const id = escapeHtml(message.id ?? '');
  const mri = escapeHtml(extractMri(message.from ?? '')).replace(/"/g, '&quot;');
  return (
    `<blockquote itemscope="" itemtype="${REPLY_TYPE}" itemid="${id}">` +
    `<strong itemprop="mri" itemid="${mri}">${escapeHtml(message.imdisplayname ?? '')}</strong>` +
    `<span itemprop="time" itemid="${id}"></span>` +
    `<p itemprop="preview">${escapeHtml(messagePreview(message))}</p>` +
    '</blockquote>'
  );
};

/**
 * The `qtdMsgs` message property naming the quoted message. In chats and channels the chat service
 * verifies the quote card against it; a card without it shows "This quoted message isn't verified
 * by Teams." The self chat verifies no quotes, so every reply there carries that note.
 */
export const quotedMessagesProperty = (message: RawMessage): string =>
  JSON.stringify([
    { messageId: message.id ?? '', sender: extractMri(message.from ?? ''), time: Number(message.id ?? 0) },
  ]);

/** Fetch the message being replied to, refusing one that was deleted or is not a chat message. */
export const getReplyTarget = async (conversationId: string, messageId: string): Promise<RawMessage> => {
  const message = await chatApi<RawMessage>(
    `/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
  );
  if (message.properties?.deletetime) {
    throw ToolError.validation(`Message ${messageId} was deleted, so there is nothing to reply to.`);
  }
  if (!['RichText/Html', 'Text', 'RichText'].includes(message.messagetype ?? '')) {
    throw ToolError.validation(
      `Message ${messageId} is a ${message.messagetype ?? 'system'} event, not a chat message, so it cannot be replied to.`,
    );
  }
  return message;
};
