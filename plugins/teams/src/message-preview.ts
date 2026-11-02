import { decodeEntities } from './html-entities.js';
import type { RawMessage } from './tools/schemas.js';

/**
 * The one-line preview Teams shows of a message, in a reply's quote card and in
 * the chat list.
 */

/** Teams cuts a preview at this many characters. */
const PREVIEW_MAX_LENGTH = 200;

/** A quote card already in a message — a preview leaves out the message it answered in turn. */
const REPLY_QUOTE = /<blockquote\b[^>]*schema\.skype\.com\/Reply[^>]*>[\s\S]*?<\/blockquote>/gi;

/** What the preview shows for an image, and for each attached file (the Teams client's own markers). */
const IMAGE_MARKER = ' 📷 ';
const FILE_MARKER = ' 📄 ';

const attachedFileCount = (message: Pick<RawMessage, 'properties'>): number => {
  try {
    const files = JSON.parse(message.properties?.files ?? '[]') as unknown;
    return Array.isArray(files) ? files.length : 0;
  } catch {
    return 0;
  }
};

/**
 * A message's preview, built as the Teams client builds it: the message text on
 * one line with 📷 for each image, then 📄 for each attached file (whose name
 * the text usually links already), cut to 200 characters.
 */
export const messagePreview = (message: Pick<RawMessage, 'content' | 'properties'>): string => {
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
