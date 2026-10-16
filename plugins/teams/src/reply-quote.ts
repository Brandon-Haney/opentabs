import { ToolError } from '@opentabs-dev/plugin-sdk';
import { escapeHtml } from './markdown-html.js';
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

/** Teams cuts a quote card's preview at this many characters. */
const PREVIEW_MAX_LENGTH = 200;

/** A quote card already in a message — a reply's preview leaves out the message it answered in turn. */
const REPLY_QUOTE = /<blockquote\b[^>]*schema\.skype\.com\/Reply[^>]*>[\s\S]*?<\/blockquote>/gi;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });

/** What the preview shows for an image, and for each attached file (the Teams client's own markers). */
const IMAGE_MARKER = ' 📷 ';
const FILE_MARKER = ' 📄 ';

const attachedFileCount = (message: RawMessage): number => {
  try {
    const files = JSON.parse(message.properties?.files ?? '[]') as unknown;
    return Array.isArray(files) ? files.length : 0;
  } catch {
    return 0;
  }
};

/**
 * The quote card's preview of a message, built as the Teams client builds it: the message text on
 * one line with 📷 for each image, then 📄 for each attached file (whose name the text usually
 * links already), cut to 200 characters — so a reply reads the same as one sent from Teams.
 */
export const replyPreview = (message: RawMessage): string => {
  const text = decodeEntities(
    (message.content ?? '')
      .replace(REPLY_QUOTE, ' ')
      .replace(/<img\b[^>]*>/gi, IMAGE_MARKER)
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|td|th|pre|blockquote)>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    // Line breaks and markup whitespace collapse; each non-breaking space (code indentation) becomes
    // a plain space without collapsing, as in Teams.
    .replace(/[ \t\r\n\f]+/g, ' ')
    .trim()
    .replace(/\u00a0/g, ' ');

  const preview = text + FILE_MARKER.repeat(attachedFileCount(message));
  if (preview.trim().length === 0) return ' ';
  return preview.length > PREVIEW_MAX_LENGTH ? `${preview.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…` : preview;
};

/** The quote card that opens a reply to `message`. */
export const replyQuoteHtml = (message: RawMessage): string => {
  const id = escapeHtml(message.id ?? '');
  const mri = escapeHtml(extractMri(message.from ?? '')).replace(/"/g, '&quot;');
  return (
    `<blockquote itemscope="" itemtype="${REPLY_TYPE}" itemid="${id}">` +
    `<strong itemprop="mri" itemid="${mri}">${escapeHtml(message.imdisplayname ?? '')}</strong>` +
    `<span itemprop="time" itemid="${id}"></span>` +
    `<p itemprop="preview">${escapeHtml(replyPreview(message))}</p>` +
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
