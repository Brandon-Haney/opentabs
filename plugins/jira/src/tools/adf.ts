// Atlassian Document Format helpers — markdown subset ↔ ADF.
//
// Supported markdown:
//   Blocks: paragraphs, ATX headings (# … ######), unordered lists
//   (- / * / +), ordered lists (1.), fenced code blocks, blockquotes,
//   horizontal rules (---).
//   Inline: bold (**…** / __…__), italic (*…* / _…_), inline code
//   (`…`), strikethrough (~~…~~), links ([text](url)).
//
// Anything outside this subset is dropped on input or best-effort
// flattened on output. Use the `body_adf` escape hatch on add_comment
// for full ADF control (mentions, panels, tables, media, …).

export interface AdfMark {
  type: 'strong' | 'em' | 'code' | 'strike' | 'link';
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

export const markdownToAdf = (md: string): AdfDoc => {
  if (!md || md.trim() === '') return emptyAdfDoc();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = parseBlocks(lines);
  return { type: 'doc', version: 1, content: blocks.length ? blocks : [{ type: 'paragraph' }] };
};

const leadingSpaces = (s: string): number => {
  const m = /^( +)/.exec(s);
  return m?.[1] ? m[1].length : 0;
};

const isBlockStart = (line: string): boolean => {
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^>/.test(line)) return true;
  if (/^```/.test(line.trimStart())) return true;
  if (/^([-*+]|\d+\.)\s+/.test(line)) return true;
  if (/^(?:---+|\*\*\*+|___+)\s*$/.test(line)) return true;
  return false;
};

const parseBlocks = (lines: string[]): AdfNode[] => {
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
      blocks.push({ type: 'blockquote', content: parseBlocks(quoteLines) });
      continue;
    }

    // List
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const result = parseList(lines, i, leadingSpaces(line));
      blocks.push(result.list);
      i = result.next;
      continue;
    }

    // Paragraph: gather contiguous non-block lines
    const paragraphLines: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const pl = lines[i] ?? '';
      if (pl.trim() === '' || isBlockStart(pl)) break;
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

const parseList = (lines: string[], start: number, baseIndent: number): ListResult => {
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

    const itemBlocks = parseBlocks(itemLines);
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
    const aHref = (am.attrs as { href?: string } | undefined)?.href;
    const bHref = (bm.attrs as { href?: string } | undefined)?.href;
    if (aHref !== bHref) return false;
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
      tryLink(rest, marks) ||
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
    case 'mediaGroup':
    case 'media':
      return '';
    default:
      return block.content ? renderBlocks(block.content) : '';
  }
};

const renderListItem = (item: AdfNode, prefix: string): string => {
  const inner = renderBlocks(item.content ?? []);
  const indent = ' '.repeat(prefix.length);
  return inner
    .split('\n')
    .map((line, idx) => (idx === 0 ? `${prefix}${line}` : `${indent}${line}`))
    .join('\n');
};

const renderInline = (nodes: AdfNode[]): string => nodes.map(renderInlineNode).join('');

const hasMark = (marks: AdfMark[], type: AdfMark['type']): boolean => marks.some(m => m.type === type);

const renderInlineNode = (node: AdfNode): string => {
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') {
    const text = (node.attrs?.text as string | undefined) ?? '';
    if (text.startsWith('@')) return text;
    const id = (node.attrs?.id as string | undefined) ?? '';
    return `@${text || id}`;
  }
  if (node.type === 'emoji') {
    return (node.attrs?.text as string | undefined) ?? (node.attrs?.shortName as string | undefined) ?? '';
  }
  if (node.type === 'inlineCard') {
    const url = (node.attrs?.url as string | undefined) ?? '';
    return url ? `<${url}>` : '';
  }
  if (node.type === 'text') {
    const marks = node.marks ?? [];
    let out = node.text ?? '';
    if (hasMark(marks, 'code')) out = `\`${out}\``;
    if (hasMark(marks, 'strike')) out = `~~${out}~~`;
    if (hasMark(marks, 'em')) out = `*${out}*`;
    if (hasMark(marks, 'strong')) out = `**${out}**`;
    const link = marks.find(m => m.type === 'link');
    if (link) {
      const href = (link.attrs as { href?: string } | undefined)?.href ?? '';
      out = `[${out}](${href})`;
    }
    return out;
  }
  return '';
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
