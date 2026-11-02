/**
 * The Teams join details Exchange writes into the body of an online meeting.
 *
 * Exchange keeps an event's Teams meeting only while its body carries these
 * details: a body update without them removes the meeting from the event, and
 * turning the meeting back on creates a new one with a different join link. A
 * body edit therefore has to carry the stored details over byte for byte.
 *
 * The body is split as a string, as `extractQuotedThread` splits a draft. HTML
 * parsed in the Outlook page passes through the page's Trusted Types default
 * policy, which strips ids, classes and styles, so a parsed copy could neither
 * find the details nor carry them over intact.
 *
 * Exchange writes the details in the body's own format. Below an HTML body they
 * are a container `<div class="me-email-text">` holding a join link with the id
 * `meet_invite_block.action.join_link`. A plain-text body is stored as HTML
 * converted from text, in lines separated by `<br>`; its details start with a
 * heading line directly above the line holding the
 * `https://teams.microsoft.com/meet/` join link, sometimes with a line of
 * underscores above the heading.
 */

const BODY_OPENING = /<body\b[^>]*>/i;
const HTML_JOIN_LINK = 'id="meet_invite_block.action.join_link"';
const HTML_DETAILS_OPENING = /<div\b[^>]*\bclass="me-email-text"[^>]*>/gi;
const TEXT_JOIN_LINK = '<a href="https://teams.microsoft.com/meet/';
const LINE_BREAK = /<br\s*\/?>/gi;
const SEPARATOR_LINE = /^\s*_{10,}\s*$/;
const TAG = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'wbr',
]);
const DOCUMENT_END = /\s*<\/body>\s*<\/html>\s*$/i;

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, '');

/** Where the body's content starts: just past `<body>`, or at the start of a fragment. */
const contentStart = (html: string): number => {
  const opening = BODY_OPENING.exec(html);
  return opening ? opening.index + opening[0].length : 0;
};

/** The `me-email-text` container that opens last before the HTML join link. */
const htmlDetailsStart = (html: string, from: number): number | null => {
  const link = html.lastIndexOf(HTML_JOIN_LINK);
  if (link < from) return null;
  let start: number | null = null;
  for (const opening of html.slice(from, link).matchAll(HTML_DETAILS_OPENING)) start = from + opening.index;
  return start;
};

/** The heading line above the plain-text join link, or the separator line above that heading. */
const textDetailsStart = (html: string, from: number): number | null => {
  const link = html.lastIndexOf(TEXT_JOIN_LINK);
  if (link < from) return null;
  const lineStarts = [from];
  for (const lineBreak of html.slice(from, link).matchAll(LINE_BREAK)) {
    lineStarts.push(from + lineBreak.index + lineBreak[0].length);
  }
  const joinLine = lineStarts.length - 1;
  const heading = lineStarts[joinLine - 1];
  if (heading === undefined) return null;
  const above = lineStarts[joinLine - 2];
  return above !== undefined && SEPARATOR_LINE.test(stripTags(html.slice(above, heading))) ? above : heading;
};

/**
 * The opening tags of the elements still open at `end`, outermost first, such as
 * the font a converted plain-text body wraps its lines in. Prefixed to the slice
 * from `end`, they balance the closing tags the slice carries.
 */
const openingTagsAt = (html: string, from: number, end: number): string => {
  const open: { name: string; tag: string }[] = [];
  for (const tag of html.slice(from, end).matchAll(TAG)) {
    const name = (tag[2] ?? '').toLowerCase();
    if (tag[1]) {
      for (let index = open.length - 1; index >= 0; index--) {
        if (open[index]?.name === name) {
          open.length = index;
          break;
        }
      }
    } else if (!VOID_ELEMENTS.has(name) && !tag[0].endsWith('/>')) {
      open.push({ name, tag: tag[0] });
    }
  }
  return open.map(element => element.tag).join('');
};

/**
 * The Teams join details in a stored event body, with everything below them, as
 * HTML ready to follow a new body. Returns null when the body holds no join
 * details in either format Exchange writes.
 */
export const extractTeamsJoinDetails = (html: string): string | null => {
  const from = contentStart(html);
  const start = htmlDetailsStart(html, from) ?? textDetailsStart(html, from);
  if (start === null) return null;
  return openingTagsAt(html, from, start) + html.slice(start).replace(DOCUMENT_END, '');
};

/** Whether an HTML body links to the given URL. */
export const linksTo = (html: string, url: string): boolean =>
  html.includes(`href="${url}"`) || html.includes(`href="${url.replace(/&/g, '&amp;')}"`);
