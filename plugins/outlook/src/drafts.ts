import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './outlook-api.js';
import type { RawEmailAddress } from './tools/schemas.js';

/** The draft fields the draft tools read before changing a message. */
export interface RawDraft {
  isDraft?: boolean;
  subject?: string;
  toRecipients?: RawEmailAddress[];
  body?: { contentType?: string; content?: string };
}

/**
 * Read a message and confirm it is still an unsent draft, so the draft tools can
 * never change or delete received or sent mail. `select` lists the extra fields
 * the caller needs; `isDraft` and `subject` are always read.
 */
export const requireDraft = async (draftId: string, action: string, select: string[] = []): Promise<RawDraft> => {
  const draft = await api<RawDraft>(`/me/messages/${draftId}`, {
    query: { $select: ['isDraft', 'subject', ...select].join(',') },
  });
  if (draft.isDraft !== true) {
    throw ToolError.validation(
      `Message "${draft.subject ?? ''}" is not a draft, so it cannot be ${action}. Only unsent drafts qualify.`,
    );
  }
  return draft;
};

/** Where Outlook on the web starts the quoted history in a reply/forward it composed. */
const OWA_QUOTE_ANCHOR = /<div\b[^>]*\bid="appendonsend"/i;

/** The From/Sent/To header block Exchange puts at the top of a quoted reply or forward. */
const QUOTE_HEADER = /<div\b[^>]*\bid="divRplyFwdMsg"/i;

/** The separator rule Exchange places just above the quote header. */
const SEPARATOR_RULE = /<hr\b[^>]*>\s*$/i;

/** `<meta>` and `<style>` elements, which carry no visible text. */
const INVISIBLE_ELEMENTS = /<meta\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style>/gi;

/**
 * Split a reply or forward draft's HTML body into the part the author wrote and
 * the quoted thread below it, returning the quoted thread (or null when the body
 * has no quoted history, as for a standalone draft).
 *
 * The thread starts at Outlook on the web's `appendonsend` anchor, or else at
 * Exchange's quote header (`divRplyFwdMsg`) together with the separator rule
 * directly above it. Exchange hoists the original message's `<head>` styles into
 * the body ahead of that point, so the `<meta>`/`<style>` elements in the authored
 * part are carried over with the thread to keep the quoted message rendering as
 * before.
 */
export const extractQuotedThread = (html: string): string | null => {
  let start = html.search(OWA_QUOTE_ANCHOR);
  if (start < 0) {
    start = html.search(QUOTE_HEADER);
    if (start < 0) return null;
    const rule = SEPARATOR_RULE.exec(html.slice(0, start));
    if (rule) start = rule.index;
  }
  const hoistedStyles = (html.slice(0, start).match(INVISIBLE_ELEMENTS) ?? []).join('');
  return `${hoistedStyles}${html.slice(start)}`;
};

/** An inline image already attached to a draft. */
export interface DraftInlineImage {
  id: string;
  contentId: string;
}

/** The inline images on a draft — attachments marked inline that carry a content id. */
export const listInlineImages = async (draftId: string): Promise<DraftInlineImage[]> => {
  const data = await api<{ value?: { id?: string; isInline?: boolean; contentId?: string }[] }>(
    `/me/messages/${draftId}/attachments`,
    { query: { $select: 'id,isInline,contentId' } },
  );
  return (data.value ?? []).flatMap(attachment =>
    attachment.isInline === true && attachment.id && attachment.contentId
      ? [{ id: attachment.id, contentId: attachment.contentId }]
      : [],
  );
};

/**
 * Delete inline images from a draft, one at a time — concurrent writes race on the
 * message's change key. Exchange itself drops an inline image once a saved body stops
 * referencing it, so an image already gone counts as deleted.
 */
export const deleteInlineImages = async (draftId: string, images: readonly DraftInlineImage[]): Promise<void> => {
  for (const image of images) {
    try {
      await api(`/me/messages/${draftId}/attachments/${image.id}`, { method: 'DELETE' });
    } catch (err) {
      if (!(err instanceof ToolError && err.category === 'not_found')) throw err;
    }
  }
};
