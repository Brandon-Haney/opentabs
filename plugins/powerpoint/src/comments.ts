/**
 * Reading reviewer comments out of a PPTX package.
 *
 * Microsoft Graph exposes no comments API for PowerPoint at any version, and
 * Office.js has no `PowerPoint.Comment`, so parsing the package parts directly
 * is the only way to read them. The package already arrives whole —
 * `downloadPptx` returns every ZIP entry — so this module is pure parsing.
 *
 * Two on-disk generations exist and a deck may hold either:
 *
 * - **Modern** (PowerPoint 2019+, and everything authored in PowerPoint for the
 *   web): one `ppt/comments/modernComment_*.xml` part per commented slide,
 *   rooted at `p188:cmLst`. Comments carry a GUID author id, an ISO timestamp,
 *   a shape anchor, and threaded replies. Authors live in `ppt/authors.xml`.
 * - **Classic**: `ppt/comments/commentN.xml` rooted at `p:cmLst`, flat text in
 *   a `<p:text>` element with no replies. Authors live in
 *   `ppt/commentAuthors.xml` keyed by a small integer.
 *
 * Both are reached identically — a relationship on the *slide* part whose Type
 * ends in `/relationships/comments` — so the reader resolves the relationship
 * first and branches on the element shape it finds, never on a filename.
 */

import { getRelatedParts, TEXT_DECODER } from './pptx-utils.js';
import { childByLocalName, childElements, descendantElements, descendantsByLocalName, parseXml } from './xml.js';

/** Matches both the modern (`office/2018/10`) and classic (`2006`) comment relationships. */
const COMMENTS_REL = '/relationships/comments';
/** Modern author registry. Does not match `commentAuthors` — the classic one. */
const AUTHORS_REL = '/relationships/authors';
/** Classic author registry. */
const COMMENT_AUTHORS_REL = '/relationships/commentAuthors';

const PRESENTATION_PART = 'ppt/presentation.xml';

export interface CommentReply {
  id: string;
  author: string;
  author_id: string;
  created: string;
  text: string;
}

export interface SlideComment {
  id: string;
  slide_number: number;
  author: string;
  author_id: string;
  created: string;
  text: string;
  /**
   * `cNvPr@id` of the shape the comment is anchored to, empty when the comment
   * is anchored to the slide itself rather than a shape.
   */
  anchor_shape_id: string;
  /**
   * Raw `status` attribute when the producer wrote one. PowerPoint drops
   * resolved and deleted comments from the package rather than flagging them,
   * so this is usually empty — it is surfaced rather than discarded only so a
   * producer that does set it is not silently ignored.
   */
  status: string;
  replies: CommentReply[];
}

/**
 * Author id → display name, merged across both registries.
 *
 * The two id spaces cannot collide: modern ids are GUIDs in braces, classic
 * ids are small integers.
 */
const readAuthorNames = (entries: Map<string, Uint8Array>): Map<string, string> => {
  const names = new Map<string, string>();
  const parts = [
    ...getRelatedParts(entries, PRESENTATION_PART, AUTHORS_REL),
    ...getRelatedParts(entries, PRESENTATION_PART, COMMENT_AUTHORS_REL),
  ];

  for (const part of parts) {
    const data = entries.get(part);
    if (!data) continue;
    const doc = parseXml(TEXT_DECODER.decode(data));
    for (const el of [...descendantsByLocalName(doc, 'author'), ...descendantsByLocalName(doc, 'cmAuthor')]) {
      const id = el.getAttribute('id');
      const name = el.getAttribute('name');
      if (id && name) names.set(id, name);
    }
  }
  return names;
};

/**
 * Text of a DrawingML `txBody`, one line per `a:p` paragraph.
 *
 * `a:br` is an explicit line break inside a paragraph; every other text
 * carrier is an `a:t` run.
 */
const extractTxBodyText = (txBody: Element): string =>
  childElements(txBody)
    .filter(p => p.localName === 'p')
    .map(p =>
      descendantElements(p)
        .filter(el => el.localName === 't' || el.localName === 'br')
        .map(el => (el.localName === 'br' ? '\n' : (el.textContent ?? '')))
        .join(''),
    )
    .join('\n')
    .trim();

/**
 * Body text of a comment or reply.
 *
 * Modern comments hold a DrawingML `txBody`; classic ones hold a plain
 * `p:text`. Both are read as *direct children*: `CT_Comment` sequences its own
 * `txBody` after its `replyLst`, so a subtree search would return a reply's
 * text for every parent comment that has replies.
 */
const extractCommentText = (cm: Element): string => {
  const txBody = childByLocalName(cm, 'txBody');
  if (txBody) return extractTxBodyText(txBody);
  return childByLocalName(cm, 'text')?.textContent?.trim() ?? '';
};

/**
 * `cNvPr@id` of the anchored shape.
 *
 * The anchor lives in a `deMkLst` of drawing markers. `docMk` and `sldMk`
 * identify the document and slide and carry no `id`; the shape marker
 * (`spMk`, `graphicFrameMk`, `picMk`, …) is the one that does.
 */
const extractAnchorShapeId = (cm: Element): string => {
  const anchor = childByLocalName(cm, 'deMkLst');
  if (!anchor) return '';
  for (const marker of descendantElements(anchor)) {
    if (!marker.localName.endsWith('Mk')) continue;
    const id = marker.getAttribute('id');
    if (id) return id;
  }
  return '';
};

const resolveAuthor = (authorId: string, names: Map<string, string>): string => names.get(authorId) ?? '';

const parseReply = (reply: Element, names: Map<string, string>): CommentReply => {
  const authorId = reply.getAttribute('authorId') ?? '';
  return {
    id: reply.getAttribute('id') ?? '',
    author: resolveAuthor(authorId, names),
    author_id: authorId,
    // Modern uses `created`; classic uses `dt`.
    created: reply.getAttribute('created') ?? reply.getAttribute('dt') ?? '',
    text: extractCommentText(reply),
  };
};

/** Parse one comment part into its comments, in document order. */
const parseCommentPart = (xml: string, slideNumber: number, names: Map<string, string>): SlideComment[] => {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root) return [];

  return childElements(root)
    .filter(cm => cm.localName === 'cm')
    .map(cm => {
      const authorId = cm.getAttribute('authorId') ?? '';
      const replyLst = childByLocalName(cm, 'replyLst');
      return {
        // Classic comments have no GUID — they identify by `idx` within a slide.
        id: cm.getAttribute('id') ?? cm.getAttribute('idx') ?? '',
        slide_number: slideNumber,
        author: resolveAuthor(authorId, names),
        author_id: authorId,
        created: cm.getAttribute('created') ?? cm.getAttribute('dt') ?? '',
        text: extractCommentText(cm),
        anchor_shape_id: extractAnchorShapeId(cm),
        status: cm.getAttribute('status') ?? '',
        replies: replyLst
          ? childElements(replyLst)
              .filter(r => r.localName === 'reply')
              .map(r => parseReply(r, names))
          : [],
      };
    });
};

/**
 * Every comment on the given slides, in slide order then document order.
 *
 * `slideFiles` must be package-absolute slide part paths in presentation order
 * (as returned by `getSlideList`) — the index into that array is what makes a
 * comment's `slide_number` meaningful. Binding a comment to its slide through
 * the slide's own relationship is exact; the `modernComment_<a>_<b>.xml`
 * filename encodes slide identity too, but that convention is undocumented.
 */
export const readComments = (entries: Map<string, Uint8Array>, slideFiles: string[]): SlideComment[] => {
  const names = readAuthorNames(entries);
  const comments: SlideComment[] = [];

  slideFiles.forEach((slideFile, index) => {
    for (const part of getRelatedParts(entries, slideFile, COMMENTS_REL)) {
      const data = entries.get(part);
      if (!data) continue;
      comments.push(...parseCommentPart(TEXT_DECODER.decode(data), index + 1, names));
    }
  });

  return comments;
};
