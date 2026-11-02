// Atlassian Document Format helpers — markdown subset ↔ ADF.
//
// Supported markdown:
//   Blocks: paragraphs, ATX headings (# … ######), unordered lists
//   (- / * / +), ordered lists (1.), fenced code blocks, blockquotes,
//   horizontal rules (---).
//   Inline: bold (**…** / __…__), italic (*…* / _…_), inline code
//   (`…`), strikethrough (~~…~~), links ([text](url)), mentions
//   (@[Display Name](accountId)), and the formatting markdown lacks, as
//   HTML tags: <u>…</u>, <sub>…</sub>, <sup>…</sup>,
//   <span style="color: #rrggbb">…</span> for text colour and
//   <mark style="background-color: #rrggbb">…</mark> for highlight.
//   Images: a line holding only ![alt](ref) becomes the block the
//   caller's `image` resolver returns for `ref` (see MarkdownOptions).
//
// Output uses the same forms, so text read from Jira can be edited and
// written back without losing its mentions or formatting. Anything
// outside this subset is dropped on input or best-effort flattened on
// output. On output every node leaves a visible trace: a date chip reads
// as YYYY-MM-DD, a status lozenge as [status: <text>], an embedded image
// as [image: <alt>], a file card as [file], and a node with no text form
// as [unsupported: <type>].
// Use the `body_adf` escape hatch on add_comment for full ADF control
// (panels, tables, media, …).

export interface AdfMark {
  type: 'strong' | 'em' | 'code' | 'strike' | 'link' | 'underline' | 'subsup' | 'textColor' | 'backgroundColor';
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

export const emptyAdfDoc = (): AdfDoc => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph' }],
});

// ==========================================================
// Markdown → ADF
// ==========================================================

export interface MarkdownOptions {
  /**
   * Resolve the image a line `![alt](ref)` names to the ADF block that shows it,
   * called once per such line. Returning undefined leaves the line as a paragraph
   * of its own.
   */
  image?: (ref: string, alt: string) => AdfNode | undefined;
}

export const markdownToAdf = (md: string, options: MarkdownOptions = {}): AdfDoc => {
  if (!md || md.trim() === '') return emptyAdfDoc();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = parseBlocks(lines, options);
  return { type: 'doc', version: 1, content: blocks.length ? blocks : [{ type: 'paragraph' }] };
};

const leadingSpaces = (s: string): number => {
  const m = /^( +)/.exec(s);
  return m?.[1] ? m[1].length : 0;
};

/** A line holding only a markdown image: `![alt](ref)`. */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

const resolveImageLine = (line: string, options: MarkdownOptions): AdfNode | undefined => {
  if (!options.image) return undefined;
  const m = IMAGE_LINE.exec(line.trim());
  return m?.[2] ? options.image(m[2], m[1] ?? '') : undefined;
};

const isBlockStart = (line: string, options: MarkdownOptions): boolean => {
  if (options.image && IMAGE_LINE.test(line.trim())) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^>/.test(line)) return true;
  if (/^```/.test(line.trimStart())) return true;
  if (/^([-*+]|\d+\.)\s+/.test(line)) return true;
  if (/^(?:---+|\*\*\*+|___+)\s*$/.test(line)) return true;
  return false;
};

const parseBlocks = (lines: string[], options: MarkdownOptions): AdfNode[] => {
  const blocks: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block
    const fence = /^```(\S*)\s*$/.exec(line.trimStart());
    if (fence) {
      const lang = fence[1] ?? '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const cl = lines[i] ?? '';
        if (/^```\s*$/.test(cl.trimStart())) break;
        codeLines.push(cl);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      const codeBlock: AdfNode = { type: 'codeBlock' };
      if (lang) codeBlock.attrs = { language: lang };
      if (codeLines.length) codeBlock.content = [{ type: 'text', text: codeLines.join('\n') }];
      blocks.push(codeBlock);
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      blocks.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    // Blockquote
    if (/^>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const ql = lines[i] ?? '';
        if (!/^>/.test(ql)) break;
        quoteLines.push(ql.replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: parseBlocks(quoteLines, options) });
      continue;
    }

    // List
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const result = parseList(lines, i, leadingSpaces(line), options);
      blocks.push(result.list);
      i = result.next;
      continue;
    }

    // Image the caller resolves
    const image = resolveImageLine(line, options);
    if (image) {
      blocks.push(image);
      i++;
      continue;
    }

    // Paragraph: gather contiguous non-block lines
    const paragraphLines: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const pl = lines[i] ?? '';
      if (pl.trim() === '' || isBlockStart(pl, options)) break;
      paragraphLines.push(pl.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', content: parseInline(paragraphLines.join(' ')) });
  }
  return blocks;
};

interface ListResult {
  list: AdfNode;
  next: number;
}

const parseList = (lines: string[], start: number, baseIndent: number, options: MarkdownOptions): ListResult => {
  const firstLine = (lines[start] ?? '').slice(baseIndent);
  const isOrdered = /^\d+\./.test(firstLine);
  const startNumMatch = /^(\d+)\./.exec(firstLine);
  const startNum = isOrdered && startNumMatch?.[1] ? parseInt(startNumMatch[1], 10) : 1;

  const items: AdfNode[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') {
      i++;
      continue;
    }
    const lineIndent = leadingSpaces(raw);
    if (lineIndent !== baseIndent) break;
    const sliced = raw.slice(baseIndent);
    const m = /^([-*+]|\d+\.)\s+(.*)$/.exec(sliced);
    if (!m?.[1]) break;
    const itemIsOrdered = /^\d+\./.test(m[1]);
    if (itemIsOrdered !== isOrdered) break;

    const restText = m[2] ?? '';
    const markerLen = m[0].length - restText.length; // marker + space(s)
    const itemIndent = baseIndent + markerLen;
    const itemLines: string[] = [restText];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim() === '') {
        // Look ahead — if a continuation line is still indented under this item, keep blank
        let j = i + 1;
        while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
        const peek = j < lines.length ? lines[j] : undefined;
        if (peek !== undefined && leadingSpaces(peek) >= itemIndent) {
          itemLines.push('');
          i++;
          continue;
        }
        break;
      }
      if (leadingSpaces(next) < itemIndent) break;
      itemLines.push(next.slice(itemIndent));
      i++;
    }

    const itemBlocks = parseBlocks(itemLines, options);
    items.push({
      type: 'listItem',
      content: itemBlocks.length ? itemBlocks : [{ type: 'paragraph' }],
    });
  }

  const list: AdfNode = isOrdered
    ? {
        type: 'orderedList',
        ...(startNum !== 1 ? { attrs: { order: startNum } } : {}),
        content: items,
      }
    : { type: 'bulletList', content: items };
  return { list, next: i };
};

// ----- Inline parser -----

const parseInline = (text: string): AdfNode[] => parseInlineWithMarks(text, []);

const cloneMark = (m: AdfMark): AdfMark => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type });

const marksEqual = (a: AdfMark[] | undefined, b: AdfMark[]): boolean => {
  const aa = a ?? [];
  if (aa.length !== b.length) return false;
  for (let i = 0; i < aa.length; i++) {
    const am = aa[i];
    const bm = b[i];
    if (!am || !bm) return false;
    if (am.type !== bm.type) return false;
    if (JSON.stringify(am.attrs ?? {}) !== JSON.stringify(bm.attrs ?? {})) return false;
  }
  return true;
};

interface MatchResult {
  len: number;
  nodes: AdfNode[];
}

const tryMark = (s: string, re: RegExp, mark: AdfMark['type'], parent: AdfMark[]): MatchResult | null => {
  const m = re.exec(s);
  if (!m?.[1]) return null;
  if (mark === 'code') {
    const node: AdfNode = {
      type: 'text',
      text: m[1],
      marks: [...parent.map(cloneMark), { type: 'code' }],
    };
    return { len: m[0].length, nodes: [node] };
  }
  return {
    len: m[0].length,
    nodes: parseInlineWithMarks(m[1], [...parent, { type: mark }]),
  };
};

/** An HTML tag standing for a mark; group 1 holds the tag's attribute value, group 2 its content. */
const tryTagMark = (
  s: string,
  re: RegExp,
  toMark: (value: string) => AdfMark,
  parent: AdfMark[],
): MatchResult | null => {
  const m = re.exec(s);
  if (!m?.[2]) return null;
  return { len: m[0].length, nodes: parseInlineWithMarks(m[2], [...parent, toMark(m[1] ?? '')]) };
};

/** Tags for the marks markdown has no syntax for, in the forms `renderTextNode` writes. */
const TAG_MARKS: { re: RegExp; toMark: (value: string) => AdfMark }[] = [
  { re: /^<u>()([\s\S]+?)<\/u>/, toMark: () => ({ type: 'underline' }) },
  { re: /^<(sub|sup)>([\s\S]+?)<\/\1>/, toMark: type => ({ type: 'subsup', attrs: { type } }) },
  {
    re: /^<span style="color: ?(#[0-9a-fA-F]{6})">([\s\S]+?)<\/span>/,
    toMark: color => ({ type: 'textColor', attrs: { color: color.toLowerCase() } }),
  },
  {
    re: /^<mark style="background-color: ?(#[0-9a-fA-F]{6})">([\s\S]+?)<\/mark>/,
    toMark: color => ({ type: 'backgroundColor', attrs: { color: color.toLowerCase() } }),
  },
];

const tryTagMarks = (s: string, parent: AdfMark[]): MatchResult | null => {
  for (const { re, toMark } of TAG_MARKS) {
    const match = tryTagMark(s, re, toMark, parent);
    if (match) return match;
  }
  return null;
};

/** `@[Display Name](accountId)`: a mention, which carries no marks. */
const tryMention = (s: string): MatchResult | null => {
  const m = /^@\[@?([^\]]+)\]\(([A-Za-z0-9:_-]+)\)/.exec(s);
  if (!m?.[1] || !m[2]) return null;
  return { len: m[0].length, nodes: [{ type: 'mention', attrs: { id: m[2], text: `@${m[1]}` } }] };
};

const tryLink = (s: string, parent: AdfMark[]): MatchResult | null => {
  const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s);
  if (!m?.[1] || !m[2]) return null;
  const linkMark: AdfMark = { type: 'link', attrs: { href: m[2] } };
  return {
    len: m[0].length,
    nodes: parseInlineWithMarks(m[1], [...parent, linkMark]),
  };
};

const parseInlineWithMarks = (text: string, marks: AdfMark[]): AdfNode[] => {
  const nodes: AdfNode[] = [];
  const pushChar = (ch: string) => {
    const last = nodes[nodes.length - 1];
    if (last && last.type === 'text' && marksEqual(last.marks, marks)) {
      last.text = (last.text ?? '') + ch;
      return;
    }
    const node: AdfNode = { type: 'text', text: ch };
    if (marks.length) node.marks = marks.map(cloneMark);
    nodes.push(node);
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const match =
      tryMark(rest, /^`([^`\n]+)`/, 'code', marks) ||
      tryMention(rest) ||
      tryLink(rest, marks) ||
      tryTagMarks(rest, marks) ||
      tryMark(rest, /^\*\*([\s\S]+?)\*\*/, 'strong', marks) ||
      tryMark(rest, /^__([\s\S]+?)__/, 'strong', marks) ||
      tryMark(rest, /^~~([\s\S]+?)~~/, 'strike', marks) ||
      tryMark(rest, /^\*([^*\n]+?)\*/, 'em', marks) ||
      tryMark(rest, /^_([^_\n]+?)_/, 'em', marks);

    if (match) {
      nodes.push(...match.nodes);
      i += match.len;
      continue;
    }
    const ch = text[i] ?? '';
    pushChar(ch);
    i++;
  }
  return nodes;
};

// ==========================================================
// ADF → markdown
// ==========================================================

export const adfToMarkdown = (doc: unknown): string => {
  const root = doc as AdfNode | undefined;
  if (!root || !Array.isArray(root.content)) return '';
  return renderBlocks(root.content)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const renderBlocks = (blocks: AdfNode[]): string =>
  blocks
    .map(renderBlock)
    .filter(s => s.length > 0)
    .join('\n\n');

const renderBlock = (block: AdfNode): string => {
  switch (block.type) {
    case 'paragraph':
      return renderInline(block.content ?? []);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(block.attrs?.level ?? 1)));
      return `${'#'.repeat(level)} ${renderInline(block.content ?? [])}`;
    }
    case 'bulletList':
      return (block.content ?? []).map(item => renderListItem(item, '- ')).join('\n');
    case 'orderedList': {
      const startNum = Number(block.attrs?.order ?? 1);
      return (block.content ?? []).map((item, idx) => renderListItem(item, `${startNum + idx}. `)).join('\n');
    }
    case 'codeBlock': {
      const lang = (block.attrs?.language as string | undefined) ?? '';
      const text = (block.content ?? []).map(n => n.text ?? '').join('');
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case 'blockquote': {
      const inner = renderBlocks(block.content ?? []);
      return inner
        .split('\n')
        .map(line => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    }
    case 'rule':
      return '---';
    case 'panel':
    case 'expand':
    case 'nestedExpand':
      return renderBlocks(block.content ?? []);
    case 'table':
      return renderTable(block);
    case 'mediaSingle':
      return (block.content ?? []).map(renderBlock).join('\n');
    case 'mediaGroup':
      return (block.content ?? []).map(() => '[file]').join('\n');
    case 'media': {
      const label = (block.attrs?.alt as string | undefined) || (block.attrs?.url as string | undefined);
      return label ? `[image: ${label}]` : '[image]';
    }
    case 'caption':
      return renderInline(block.content ?? []);
    case 'taskList':
      return (block.content ?? []).map(renderTaskListChild).join('\n');
    case 'decisionList':
      return (block.content ?? [])
        .map(item => prefixLines(renderInline(item.content ?? []), '- Decision: '))
        .join('\n');
    case 'blockCard':
    case 'embedCard':
      return renderCard(block);
    default:
      return block.content ? renderBlocks(block.content) : renderInlineNode(block);
  }
};

const prefixLines = (inner: string, prefix: string): string => {
  const indent = ' '.repeat(prefix.length);
  return inner
    .split('\n')
    .map((line, idx) => (idx === 0 ? `${prefix}${line}` : `${indent}${line}`))
    .join('\n');
};

const renderListItem = (item: AdfNode, prefix: string): string => prefixLines(renderBlocks(item.content ?? []), prefix);

/** A task list holds checkable items and, for indented tasks, nested task lists. */
const renderTaskListChild = (child: AdfNode): string => {
  if (child.type !== 'taskItem') return prefixLines(renderBlock(child), '  ');
  const checkbox = child.attrs?.state === 'DONE' ? '[x]' : '[ ]';
  return prefixLines(renderInline(child.content ?? []), `- ${checkbox} `);
};

const renderInline = (nodes: AdfNode[]): string => nodes.map(renderInlineNode).join('');

const hasMark = (marks: AdfMark[], type: AdfMark['type']): boolean => marks.some(m => m.type === type);

const unsupported = (node: AdfNode): string => `[unsupported: ${node.type}]`;

/** A smart link's URL sits in `url`, or in `data` when the card carries JSON-LD. */
const renderCard = (node: AdfNode): string => {
  const data = node.attrs?.data as { url?: string } | undefined;
  const url = (node.attrs?.url as string | undefined) || data?.url;
  return url ? `<${url}>` : unsupported(node);
};

/**
 * A date chip stores its calendar day as UTC midnight in epoch milliseconds, so the
 * day is read in UTC. A local timezone west of UTC would show the day before.
 */
const renderDate = (node: AdfNode): string => {
  const date = new Date(Number(node.attrs?.timestamp));
  return Number.isNaN(date.getTime()) ? unsupported(node) : date.toISOString().slice(0, 10);
};

const renderLabelled = (node: AdfNode, label: string): string => {
  const text = node.attrs?.text as string | undefined;
  return text ? `[${label}: ${text}]` : unsupported(node);
};

/** A mention reads as `@[Name](accountId)`, the form the markdown parser turns back into a mention. */
const renderMention = (node: AdfNode): string => {
  const name = ((node.attrs?.text as string | undefined) ?? '').replace(/^@/, '');
  const id = (node.attrs?.id as string | undefined) ?? '';
  return id ? `@[${name || id}](${id})` : `@${name}`;
};

const markColor = (mark: AdfMark | undefined): string | undefined => {
  const color = (mark?.attrs as { color?: unknown } | undefined)?.color;
  return typeof color === 'string' && color ? color : undefined;
};

const renderTextNode = (node: AdfNode): string => {
  const marks = node.marks ?? [];
  let out = node.text ?? '';
  if (hasMark(marks, 'code')) out = `\`${out}\``;
  if (hasMark(marks, 'strike')) out = `~~${out}~~`;
  if (hasMark(marks, 'em')) out = `*${out}*`;
  if (hasMark(marks, 'strong')) out = `**${out}**`;
  if (hasMark(marks, 'underline')) out = `<u>${out}</u>`;
  const subsup = (marks.find(m => m.type === 'subsup')?.attrs as { type?: unknown } | undefined)?.type;
  if (subsup === 'sub' || subsup === 'sup') out = `<${subsup}>${out}</${subsup}>`;
  const color = markColor(marks.find(m => m.type === 'textColor'));
  if (color) out = `<span style="color: ${color}">${out}</span>`;
  const highlight = markColor(marks.find(m => m.type === 'backgroundColor'));
  if (highlight) out = `<mark style="background-color: ${highlight}">${out}</mark>`;
  const link = marks.find(m => m.type === 'link');
  if (link) {
    const href = (link.attrs as { href?: string } | undefined)?.href ?? '';
    out = `[${out}](${href})`;
  }
  return out;
};

const renderInlineNode = (node: AdfNode): string => {
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return renderMention(node);
  if (node.type === 'emoji') {
    return (
      (node.attrs?.text as string | undefined) || (node.attrs?.shortName as string | undefined) || unsupported(node)
    );
  }
  if (node.type === 'inlineCard') return renderCard(node);
  if (node.type === 'date') return renderDate(node);
  if (node.type === 'status') return renderLabelled(node, 'status');
  if (node.type === 'placeholder') return renderLabelled(node, 'placeholder');
  if (node.type === 'mediaInline') {
    const alt = node.attrs?.alt as string | undefined;
    if (alt) return `[image: ${alt}]`;
    return node.attrs?.type === 'image' ? '[image]' : '[file]';
  }
  if (node.type === 'text') return renderTextNode(node);
  return node.content ? renderBlock(node) : unsupported(node);
};

const renderTable = (block: AdfNode): string => {
  const rows = (block.content ?? []).filter(r => r.type === 'tableRow');
  if (rows.length === 0) return '';
  const cellText = (cell: AdfNode): string =>
    renderBlocks(cell.content ?? [])
      .replace(/\n+/g, ' ')
      .trim();
  const matrix = rows.map(row =>
    (row.content ?? []).filter(c => c.type === 'tableCell' || c.type === 'tableHeader').map(cellText),
  );
  const header = matrix[0] ?? [];
  const cols = Math.max(0, ...matrix.map(r => r.length));
  if (cols === 0) return '';
  const sep: string[] = Array.from({ length: cols }, () => '---');
  const body = matrix.slice(1);
  const formatRow = (row: string[]): string =>
    `| ${Array.from({ length: cols }, (_, i) => row[i] ?? '').join(' | ')} |`;
  return [formatRow(header), formatRow(sep), ...body.map(formatRow)].join('\n');
};
