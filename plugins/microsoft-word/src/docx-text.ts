/**
 * Read a Word document's text without losing the marks that change its meaning.
 *
 * Plain text extraction reads struck-through text as if it were current, and
 * shows a tracked deletion as live text or not at all. Authors commonly strike
 * text to mark it removed, so the reader here keeps each such mark in the text:
 *
 *   ~~text~~          struck through (w:strike / w:dstrike)
 *   {+text+}          tracked insertion (w:ins, w:moveTo)
 *   [-text-]          tracked deletion (w:del, w:moveFrom)
 *   [image: name]     an image, named by its alt text or else its file name
 *   [text box: …]     a text box's paragraphs, joined by " / "
 *   [COMMENT id]      where a comment's range starts; the comment is listed apart
 *
 * Headings start with one `#` per level, and each table row reads as
 * `| cell | cell |`, with a cell's paragraphs joined by " / ".
 *
 * Parsing goes through DOMParser and matches elements by namespace and local
 * name, so prefixes, entities and elements whose names begin alike (w:t, w:tab,
 * w:tbl) are read correctly.
 */

import { ToolError } from '@opentabs-dev/plugin-sdk';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15_NS = 'http://schemas.microsoft.com/office/word/2012/wordml';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const V_NS = 'urn:schemas-microsoft-com:vml';

/** The package parts the reader uses; every part but the document is optional. */
export interface DocxTextParts {
  /** `word/document.xml`. */
  document: string;
  /** `word/comments.xml`. */
  comments?: string | null;
  /** `word/commentsExtended.xml`: which comments are replies, and which are resolved. */
  commentsExtended?: string | null;
  /** `word/_rels/document.xml.rels`: image file names. */
  relationships?: string | null;
  /** `word/styles.xml`: which paragraph styles are headings. */
  styles?: string | null;
}

export interface DocumentComment {
  id: string;
  author: string;
  date: string;
  text: string;
  resolved: boolean;
  /** The id of the comment this one replies to, or null for a comment that starts a thread. */
  reply_to: string | null;
}

export interface DocumentMarks {
  struck: number;
  insertions: number;
  deletions: number;
  comments: number;
  images: number;
}

export interface DocumentText {
  paragraphs: string[];
  comments: DocumentComment[];
  marks: DocumentMarks;
}

type Change = 'insertion' | 'deletion' | null;

/** A stretch of a paragraph: text that shares its marks, or a token such as an image. */
interface Segment {
  text: string;
  struck: boolean;
  change: Change;
}

const CHANGE_MARKERS = {
  insertion: ['{+', '+}'],
  deletion: ['[-', '-]'],
} as const;

const parseXml = (xml: string, part: string): Document => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw ToolError.internal(`Could not parse ${part} in the .docx archive.`);
  }
  return doc;
};

const isEl = (el: Element, ns: string, name: string): boolean => el.namespaceURI === ns && el.localName === name;

const isW = (el: Element, name: string): boolean => isEl(el, W_NS, name);

const wAttr = (el: Element, name: string): string | null => el.getAttributeNS(W_NS, name);

const childW = (el: Element, name: string): Element | undefined =>
  Array.from(el.children).find(child => isW(child, name));

const descendants = (root: Element, ns: string, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(ns, name));

/** Whether an element of this name lies between `el` and `root`, exclusive of both. */
const isInside = (el: Element, root: Element, ns: string, name: string): boolean => {
  for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (isEl(parent, ns, name)) return true;
  }
  return false;
};

/** A toggle property (w:strike, w:dstrike) is on unless its w:val turns it off. */
const isOn = (el: Element | undefined): boolean =>
  el !== undefined && !['0', 'false', 'off'].includes(wAttr(el, 'val') ?? '');

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Wrap the text in markers, leaving its outer whitespace outside them; whitespace alone stays unmarked. */
const markWhole = (text: string, open: string, close: string): string | null => {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return match?.[2] ? `${match[1]}${open}${match[2]}${close}${match[3]}` : null;
};

/** Split segments into runs of neighbours that share a key. */
const groupAdjacent = <T, K>(items: T[], key: (item: T) => K): T[][] => {
  const groups: T[][] = [];
  let previous: K | undefined;
  for (const item of items) {
    const current = key(item);
    const last = groups.at(-1);
    if (last && current === previous) last.push(item);
    else groups.push([item]);
    previous = current;
  }
  return groups;
};

const relationshipTargets = (xml: string | null | undefined): Map<string, string> => {
  const targets = new Map<string, string>();
  if (!xml) return targets;
  for (const rel of Array.from(parseXml(xml, 'word/_rels/document.xml.rels').documentElement.children)) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) targets.set(id, target);
  }
  return targets;
};

/**
 * Heading levels by paragraph style id. Built-in heading styles keep the
 * English names "heading 1" … "heading 9" in every language, while their ids
 * are localized, so the names decide.
 */
const headingLevels = (xml: string | null | undefined): Map<string, number> => {
  const levels = new Map<string, number>();
  if (!xml) return levels;
  for (const style of descendants(parseXml(xml, 'word/styles.xml').documentElement, W_NS, 'style')) {
    const id = wAttr(style, 'styleId');
    const name = childW(style, 'name');
    const match = name ? /^heading (\d)$/i.exec(wAttr(name, 'val') ?? '') : null;
    if (id && match?.[1]) levels.set(id, Number(match[1]));
  }
  return levels;
};

const headingLevelOf = (styleId: string, levels: Map<string, number>): number | undefined => {
  if (levels.size > 0) return levels.get(styleId);
  const match = /^heading\s?(\d)$/i.exec(styleId);
  return match?.[1] ? Number(match[1]) : undefined;
};

interface CommentThreads {
  /** Comments that start a thread; only these get an anchor in the text. */
  topLevel: Set<string>;
  comments: DocumentComment[];
}

class DocxTextReader {
  readonly marks: DocumentMarks = { struck: 0, insertions: 0, deletions: 0, comments: 0, images: 0 };

  constructor(
    private readonly relationships: Map<string, string>,
    private readonly headings: Map<string, number>,
    private readonly anchoredComments: Set<string>,
    /** Comments whose range has no start, anchored at their reference instead. */
    private readonly anchorAtReference: Set<string>,
  ) {}

  blockLines(container: Element): string[] {
    const lines: string[] = [];
    for (const child of Array.from(container.children)) {
      if (isW(child, 'p')) {
        const text = this.paragraphText(child);
        if (text) lines.push(text);
      } else if (isW(child, 'tbl')) {
        lines.push(...this.tableRows(child));
      } else if (isW(child, 'sdt')) {
        const content = childW(child, 'sdtContent');
        if (content) lines.push(...this.blockLines(content));
      } else if (isW(child, 'customXml') || isW(child, 'sdtContent')) {
        lines.push(...this.blockLines(child));
      }
    }
    return lines;
  }

  paragraphText(paragraph: Element): string {
    const segments: Segment[] = [];
    this.walkInline(paragraph, null, segments);
    const text = this.render(segments).trim();
    if (!text) return '';
    const props = childW(paragraph, 'pPr');
    const style = props && childW(props, 'pStyle');
    const level = style ? headingLevelOf(wAttr(style, 'val') ?? '', this.headings) : undefined;
    return level ? `${'#'.repeat(level)} ${text}` : text;
  }

  private tableRows(table: Element): string[] {
    return Array.from(table.children)
      .filter(row => isW(row, 'tr'))
      .map(row => {
        const cells = Array.from(row.children)
          .filter(cell => isW(cell, 'tc'))
          .map(cell => this.blockLines(cell).join(' / '));
        return `| ${cells.join(' | ')} |`;
      });
  }

  private walkInline(el: Element, change: Change, out: Segment[]): void {
    for (const child of Array.from(el.children)) {
      if (isW(child, 'r') || isEl(child, M_NS, 'r')) this.run(child, change, out);
      else if (isW(child, 'ins') || isW(child, 'moveTo')) this.walkInline(child, 'insertion', out);
      else if (isW(child, 'del') || isW(child, 'moveFrom')) this.walkInline(child, 'deletion', out);
      else if (isW(child, 'commentRangeStart')) this.anchor(child, out);
      else if (!isW(child, 'pPr')) this.walkInline(child, change, out);
    }
  }

  private anchor(el: Element, out: Segment[]): void {
    const id = wAttr(el, 'id');
    if (id !== null && this.anchoredComments.has(id))
      out.push({ text: `[COMMENT ${id}]`, struck: false, change: null });
  }

  private run(run: Element, change: Change, out: Segment[]): void {
    const props = childW(run, 'rPr');
    const struck = props !== undefined && (isOn(childW(props, 'strike')) || isOn(childW(props, 'dstrike')));
    this.runContent(run, struck, change, out);
  }

  private runContent(el: Element, struck: boolean, change: Change, out: Segment[]): void {
    const text = (value: string) => out.push({ text: value, struck, change });
    for (const child of Array.from(el.children)) {
      if (isW(child, 't') || isW(child, 'delText') || isEl(child, M_NS, 't')) text(child.textContent ?? '');
      else if (isW(child, 'tab') || isW(child, 'ptab')) text('\t');
      else if (isW(child, 'br')) {
        const type = wAttr(child, 'type');
        if (type !== 'page' && type !== 'column') text('\n');
      } else if (isW(child, 'cr')) text('\n');
      else if (isW(child, 'noBreakHyphen')) text('-');
      else if (isW(child, 'drawing') || isW(child, 'pict') || isW(child, 'object')) this.drawing(child, change, out);
      else if (isEl(child, MC_NS, 'AlternateContent')) {
        // Word renders the first choice; the fallback repeats the same content in VML.
        const choice = Array.from(child.children).find(c => isEl(c, MC_NS, 'Choice'));
        if (choice) this.runContent(choice, struck, change, out);
      } else if (isW(child, 'commentReference')) {
        const id = wAttr(child, 'id');
        if (id !== null && this.anchorAtReference.has(id)) this.anchor(child, out);
      }
    }
  }

  private drawing(el: Element, change: Change, out: Segment[]): void {
    const imageIds = [
      ...descendants(el, A_NS, 'blip').map(blip => blip.getAttributeNS(R_NS, 'embed')),
      ...descendants(el, V_NS, 'imagedata').map(data => data.getAttributeNS(R_NS, 'id')),
    ].filter((id): id is string => Boolean(id));
    if (imageIds.length > 0) {
      const docPr = descendants(el, WP_NS, 'docPr')[0];
      const alt = docPr?.getAttribute('descr')?.trim() || docPr?.getAttribute('title')?.trim();
      const file = baseName(this.relationships.get(imageIds[0] ?? '') ?? '');
      const name = alt || file;
      this.marks.images++;
      out.push({ text: name ? `[image: ${name}]` : '[image]', struck: false, change });
    }
    const boxes = descendants(el, W_NS, 'txbxContent').filter(box => !isInside(box, el, W_NS, 'txbxContent'));
    for (const box of boxes) {
      const lines = this.blockLines(box);
      if (lines.length > 0) out.push({ text: `[text box: ${lines.join(' / ')}]`, struck: false, change });
    }
  }

  /**
   * Render segments with their marks. Neighbours with the same change merge
   * into one marked span, and within it neighbours with the same strike merge,
   * so Word's run splits (one per edit session) don't fragment the markers.
   */
  private render(segments: Segment[]): string {
    return groupAdjacent(segments, s => s.change)
      .map(group => {
        const inner = groupAdjacent(group, s => s.struck)
          .map(stretch => {
            const text = stretch.map(s => s.text).join('');
            if (!stretch[0]?.struck) return text;
            const marked = markWhole(text, '~~', '~~');
            if (marked) this.marks.struck++;
            return marked ?? text;
          })
          .join('');
        const change = group[0]?.change;
        if (!change) return inner;
        const [open, close] = CHANGE_MARKERS[change];
        const marked = markWhole(inner, open, close);
        if (marked) this.marks[change === 'insertion' ? 'insertions' : 'deletions']++;
        return marked ?? inner;
      })
      .join('');
  }
}

/**
 * Read comments with their threads. A comment's paragraphs carry w14:paraId,
 * and commentsExtended.xml keys each comment by its last paragraph's id,
 * naming the parent paragraph for a reply and `done` for a resolved thread.
 */
const readComments = (
  commentsXml: string | null | undefined,
  extendedXml: string | null | undefined,
): CommentThreads => {
  const threads: CommentThreads = { topLevel: new Set(), comments: [] };
  if (!commentsXml) return threads;

  const extended = new Map<string, { parent: string | null; done: boolean }>();
  if (extendedXml) {
    for (const ex of descendants(
      parseXml(extendedXml, 'word/commentsExtended.xml').documentElement,
      W15_NS,
      'commentEx',
    )) {
      const paraId = ex.getAttributeNS(W15_NS, 'paraId');
      if (paraId) {
        extended.set(paraId, {
          parent: ex.getAttributeNS(W15_NS, 'paraIdParent'),
          done: ex.getAttributeNS(W15_NS, 'done') === '1',
        });
      }
    }
  }

  const textReader = new DocxTextReader(new Map(), new Map(), new Set(), new Set());
  const commentByParaId = new Map<string, string>();
  const pending: { comment: DocumentComment; parentParaId: string | null }[] = [];
  for (const el of descendants(parseXml(commentsXml, 'word/comments.xml').documentElement, W_NS, 'comment')) {
    const id = wAttr(el, 'id') ?? '';
    const paragraphs = Array.from(el.children).filter(child => isW(child, 'p'));
    const paraId = paragraphs.at(-1)?.getAttributeNS(W14_NS, 'paraId') ?? null;
    const thread = paraId ? extended.get(paraId) : undefined;
    if (paraId) commentByParaId.set(paraId, id);
    pending.push({
      comment: {
        id,
        author: wAttr(el, 'author') ?? '',
        date: wAttr(el, 'date') ?? '',
        text: paragraphs
          .map(p => textReader.paragraphText(p))
          .filter(Boolean)
          .join('\n'),
        resolved: thread?.done ?? false,
        reply_to: null,
      },
      parentParaId: thread?.parent ?? null,
    });
  }

  for (const { comment, parentParaId } of pending) {
    comment.reply_to = (parentParaId && commentByParaId.get(parentParaId)) || null;
    if (comment.reply_to === null) threads.topLevel.add(comment.id);
    threads.comments.push(comment);
  }
  return threads;
};

/** Read a document's paragraphs with their marks, and its comments. */
export const readDocumentText = (parts: DocxTextParts): DocumentText => {
  const body = childW(parseXml(parts.document, 'word/document.xml').documentElement, 'body');
  if (!body) throw ToolError.internal('word/document.xml has no document body.');

  const threads = readComments(parts.comments, parts.commentsExtended);
  const rangeStarts = new Set(descendants(body, W_NS, 'commentRangeStart').map(el => wAttr(el, 'id') ?? ''));
  const anchorAtReference = new Set([...threads.topLevel].filter(id => !rangeStarts.has(id)));

  const reader = new DocxTextReader(
    relationshipTargets(parts.relationships),
    headingLevels(parts.styles),
    threads.topLevel,
    anchorAtReference,
  );
  const paragraphs = reader.blockLines(body);
  return {
    paragraphs,
    comments: threads.comments,
    marks: { ...reader.marks, comments: threads.comments.length },
  };
};
