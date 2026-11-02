import { decodeEntities } from './html-entities.js';
import { HIGHLIGHT_COLORS, TEXT_COLORS } from './markdown-html.js';

/**
 * Teams message HTML as Markdown, in the form `markdownToTeamsHtml` reads, so a
 * message read with read_messages can be edited and sent back with its
 * formatting: **bold**, *italic*, ~~strike~~, `code`, fenced code with its
 * language, [links](url), lists (nested by indent), "#" headings, "> " quotes,
 * "---" rules, pipe tables, and <u>, colour, highlight and size spans named by
 * their composer swatches. A mention reads as @[Name], or @[Shown](Full Name)
 * when it shows only part of the name; an emoji as its character; an image as
 * [image]. The quote card a reply opens with is returned apart from the text.
 *
 * Blank lines follow the composer: Teams separates paragraphs, headings and
 * tables with an empty paragraph, which reads as a blank line, while paragraphs
 * written on consecutive lines read as consecutive lines.
 *
 * The HTML is parsed from its text rather than by the page's DOMParser, whose
 * input passes through the page's Trusted Types policy (in Outlook that policy
 * strips ids, classes and styles), so the result is the same in every page.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ElementNode {
  kind: 'element';
  name: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

interface TextNode {
  kind: 'text';
  text: string;
}

type HtmlNode = ElementNode | TextNode;

const VOID_ELEMENTS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const parseAttributes = (source: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
};

/** The message HTML as a tree, tolerating unclosed and stray tags as a browser does. */
const parseHtml = (html: string): ElementNode => {
  const root: ElementNode = { kind: 'element', name: '#root', attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  for (const token of html.matchAll(TOKEN)) {
    const [whole, closing, rawName, rawAttrs] = token;
    const parent = stack[stack.length - 1] ?? root;
    if (whole.startsWith('<!--')) continue;
    if (rawName === undefined) {
      parent.children.push({ kind: 'text', text: decodeEntities(whole) });
      continue;
    }
    const name = rawName.toLowerCase();
    if (closing) {
      const open = stack.map(element => element.name).lastIndexOf(name);
      if (open > 0) stack.length = open;
      continue;
    }
    const element: ElementNode = { kind: 'element', name, attrs: parseAttributes(rawAttrs ?? ''), children: [] };
    parent.children.push(element);
    if (!VOID_ELEMENTS.has(name) && !(rawAttrs ?? '').trimEnd().endsWith('/')) stack.push(element);
  }
  return root;
};

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

const MENTION_TYPE = 'schema.skype.com/Mention';
const EMOJI_TYPE = 'schema.skype.com/Emoji';
const REPLY_TYPE = 'schema.skype.com/Reply';

const isType = (element: ElementNode, type: string): boolean => (element.attrs.itemtype ?? '').includes(type);

/** Swatch names by the hex Teams stores, for colour and highlight. */
const swatchByHex = (palette: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(palette).map(([name, hex]) => [hex.toLowerCase(), name]));
const TEXT_SWATCHES = swatchByHex(TEXT_COLORS);
const HIGHLIGHT_SWATCHES = swatchByHex(HIGHLIGHT_COLORS);
const FONT_SIZE_NAMES: Record<string, string> = { 'x-large': 'large', 'xx-small': 'small' };

/** A span's style as the composer swatches the writer accepts; empty when it carries none. */
const spanStyle = (style: string): string => {
  const declarations: string[] = [];
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    const name =
      property === 'color'
        ? TEXT_SWATCHES.get(value)
        : property === 'background-color'
          ? HIGHLIGHT_SWATCHES.get(value)
          : property === 'font-size'
            ? FONT_SIZE_NAMES[value]
            : undefined;
    if (name) declarations.push(`${property}:${name}`);
  }
  return declarations.join('; ');
};

/** Wrap text in a mark, keeping the whitespace at either end outside it so the Markdown still parses. */
const mark = (text: string, open: string, close = open): string => {
  const inner = text.trim();
  if (inner === '') return text;
  const lead = text.slice(0, text.indexOf(inner));
  const trail = text.slice(text.indexOf(inner) + inner.length);
  return `${lead}${open}${inner}${close}${trail}`;
};

const textOf = (node: HtmlNode): string =>
  node.kind === 'text' ? node.text : node.name === 'br' ? '\n' : node.children.map(textOf).join('');

interface InlineContext {
  /** Full display names of the message's mentions, by `itemid`. */
  mentionNames: ReadonlyMap<string, string>;
}

/** A name without the bracketed tags Teams appends, such as "[C]", which @[...] cannot hold. */
const withoutTags = (name: string): string =>
  name
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A mention as send_message writes one: @[Shown] when the shown text names the
 * person, or @[Shown](Full Name) when it shows only part of the name. Tags such
 * as "[C]" are left out of both, as the writer matches names without them.
 */
const writtenMention = (shown: string, fullName: string | undefined): string => {
  const text = withoutTags(shown);
  const full = fullName ? withoutTags(fullName) : '';
  return full && full.toLowerCase() !== text.toLowerCase() ? `@[${text}](${full})` : `@[${text}]`;
};

/** Inline nodes as Markdown text; a line break reads as "\n". */
const renderInline = (nodes: readonly HtmlNode[], context: InlineContext): string => {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    if (node.kind === 'text') {
      out += node.text.replace(/[ \t\r\n\f]+/g, ' ');
      continue;
    }
    if (node.name === 'span' && isType(node, MENTION_TYPE)) {
      // Teams writes a name it splits across spans as consecutive spans sharing one itemid.
      const id = node.attrs.itemid ?? '';
      let shown = textOf(node);
      while (true) {
        const gap = nodes[i + 1];
        const next = gap?.kind === 'text' && gap.text.trim() === '' ? nodes[i + 2] : gap;
        if (next?.kind !== 'element' || !isType(next, MENTION_TYPE) || (next.attrs.itemid ?? '') !== id) break;
        shown += `${next === gap ? '' : ' '}${textOf(next)}`;
        i += next === gap ? 1 : 2;
      }
      out += writtenMention(shown, context.mentionNames.get(id));
      continue;
    }
    out += renderInlineElement(node, context);
  }
  return out;
};

const renderInlineElement = (element: ElementNode, context: InlineContext): string => {
  const inner = (): string => renderInline(element.children, context);
  switch (element.name) {
    case 'br':
      return '\n';
    case 'strong':
    case 'b':
      return mark(inner(), '**');
    case 'i':
    case 'em':
      return mark(inner(), '*');
    case 's':
    case 'strike':
    case 'del':
      return mark(inner(), '~~');
    case 'u':
      return mark(inner(), '<u>', '</u>');
    case 'code':
      return mark(textOf(element), '`');
    case 'a': {
      const text = inner();
      const href = element.attrs.href ?? '';
      if (!href || text.trim() === href || `mailto:${text.trim()}` === href) return text || href;
      return text.trim() ? `[${text.trim()}](${href})` : href;
    }
    case 'img':
      if (isType(element, EMOJI_TYPE)) return element.attrs.alt ?? '';
      return '[image]';
    case 'at':
      return `@[${textOf(element).trim()}]`;
    case 'span': {
      const style = spanStyle(element.attrs.style ?? '');
      return style ? mark(inner(), `<span style="${style}">`, '</span>') : inner();
    }
    default:
      return inner();
  }
};

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A rendered block: its Markdown, and whether Teams lays it flush (no margin of its own). */
interface Block {
  markdown: string;
  flush: boolean;
  /** An empty paragraph came before it: the composer's blank line. */
  spaced: boolean;
}

const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'hr',
]);

const isBlock = (node: HtmlNode): boolean => node.kind === 'element' && BLOCK_ELEMENTS.has(node.name);

const trimLines = (text: string): string =>
  text
    .split('\n')
    .map(line => line.replace(/\u00a0/g, ' ').trim())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');

/** A list as Markdown lines, nested lists indented two spaces per level. */
const renderList = (list: ElementNode, depth: number, context: InlineContext): string[] => {
  const lines: string[] = [];
  let number = 1;
  for (const item of list.children) {
    if (item.kind !== 'element' || item.name !== 'li') continue;
    const nested = item.children.filter(
      (child): child is ElementNode => child.kind === 'element' && (child.name === 'ul' || child.name === 'ol'),
    );
    const content = item.children.filter(child => !nested.includes(child as ElementNode));
    const text = trimLines(
      content
        .map(child =>
          isBlock(child)
            ? `\n${renderInline((child as ElementNode).children, context)}\n`
            : renderInline([child], context),
        )
        .join(''),
    )
      .split('\n')
      .filter(Boolean)
      .join('<br>');
    const marker = list.name === 'ol' ? `${number++}.` : '-';
    lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
    for (const child of nested) lines.push(...renderList(child, depth + 1, context));
  }
  return lines;
};

/** A table as pipe rows, its first row read as the header as the writer writes it. */
const renderTable = (table: ElementNode, context: InlineContext): string => {
  const rows: string[][] = [];
  const collect = (node: ElementNode): void => {
    for (const child of node.children) {
      if (child.kind !== 'element') continue;
      if (child.name === 'tr') {
        rows.push(
          child.children
            .filter(
              (cell): cell is ElementNode => cell.kind === 'element' && (cell.name === 'td' || cell.name === 'th'),
            )
            .map(cell =>
              trimLines(
                cell.children
                  .map(part =>
                    isBlock(part)
                      ? `\n${renderInline((part as ElementNode).children, context)}\n`
                      : renderInline([part], context),
                  )
                  .join(''),
              )
                .split('\n')
                .filter(Boolean)
                .join('<br>'),
            ),
        );
      } else {
        collect(child);
      }
    }
  };
  collect(table);
  const width = Math.max(0, ...rows.map(row => row.length));
  if (width === 0) return '';
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [line(header), line(Array(width).fill('---')), ...body.map(line)].join('\n');
};

const codeLanguage = (pre: ElementNode): string => {
  const language = /\blanguage-([\w#+.-]+)/.exec(pre.attrs.class ?? '')?.[1] ?? '';
  return language === 'plaintext' || language === 'was-manually-selected' ? '' : language;
};

/** Render a container's children as blocks; inline runs between blocks read as paragraphs. */
const renderBlocks = (nodes: readonly HtmlNode[], context: InlineContext): Block[] => {
  const blocks: Block[] = [];
  let spaced = false;
  let inline: HtmlNode[] = [];

  const push = (markdown: string, flush: boolean): void => {
    blocks.push({ markdown, flush, spaced });
    spaced = false;
  };
  const flushInline = (): void => {
    const text = trimLines(renderInline(inline, context));
    inline = [];
    if (text) push(text, true);
  };

  for (const node of nodes) {
    if (!isBlock(node)) {
      inline.push(node);
      continue;
    }
    flushInline();
    const element = node as ElementNode;
    switch (element.name) {
      case 'p':
      case 'div': {
        if (element.children.some(isBlock)) {
          const inner = renderBlocks(element.children, context);
          if (inner[0]) inner[0].spaced ||= spaced;
          spaced = false;
          blocks.push(...inner);
          break;
        }
        const text = trimLines(renderInline(element.children, context));
        if (text === '') spaced = true;
        else push(text, true);
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = trimLines(renderInline(element.children, context)).replace(/\n/g, ' ');
        if (text) push(`${'#'.repeat(Number(element.name[1]))} ${text}`, true);
        break;
      }
      case 'ul':
      case 'ol': {
        const lines = renderList(element, 0, context);
        if (lines.length) push(lines.join('\n'), false);
        break;
      }
      case 'table': {
        const table = renderTable(element, context);
        if (table) push(table, true);
        break;
      }
      case 'blockquote': {
        const inner = joinBlocks(renderBlocks(element.children, context));
        if (inner)
          push(
            inner
              .split('\n')
              .map(line => (line ? `> ${line}` : '>'))
              .join('\n'),
            false,
          );
        break;
      }
      case 'pre': {
        const code = textOf(element)
          .replace(/\r\n?/g, '\n')
          .replace(/\u00a0/g, ' ')
          .replace(/\n+$/, '');
        push(`\`\`\`${codeLanguage(element)}\n${code}\n\`\`\``, false);
        break;
      }
      case 'hr':
        push('---', false);
        break;
    }
  }
  flushInline();
  return blocks;
};

/**
 * Join blocks as the writer reads them back: two flush blocks are a blank line
 * apart when an empty paragraph separated them and a line apart otherwise; any
 * other neighbours are a blank line apart, which the writer reads without
 * adding space.
 */
const joinBlocks = (blocks: readonly Block[]): string =>
  blocks
    .map((block, index) => {
      if (index === 0) return block.markdown;
      const previous = blocks[index - 1];
      const tight = previous?.flush && block.flush && !block.spaced;
      return `${tight ? '\n' : '\n\n'}${block.markdown}`;
    })
    .join('');

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** The message a reply quotes, from the quote card it opens with. */
export interface QuotedMessage {
  /** Id of the quoted message. */
  id: string;
  /** Display name of the quoted message's author. */
  author: string;
  /** The card's one-line preview of the quoted message. */
  preview: string;
}

export interface MessageMarkdown {
  markdown: string;
  quoted: QuotedMessage | null;
}

const findQuote = (root: ElementNode): ElementNode | null => {
  for (const child of root.children) {
    if (child.kind === 'element' && child.name === 'blockquote' && isType(child, REPLY_TYPE)) return child;
  }
  return null;
};

const quotedMessage = (quote: ElementNode): QuotedMessage => {
  const find = (node: ElementNode, prop: string): ElementNode | undefined => {
    for (const child of node.children) {
      if (child.kind !== 'element') continue;
      if (child.attrs.itemprop === prop) return child;
      const nested = find(child, prop);
      if (nested) return nested;
    }
    return undefined;
  };
  const author = find(quote, 'mri');
  const preview = find(quote, 'preview');
  return {
    id: quote.attrs.itemid ?? '',
    author: author ? textOf(author).trim() : '',
    preview: preview ? textOf(preview).replace(/\s+/g, ' ').trim() : '',
  };
};

/**
 * A Teams `RichText/Html` message as Markdown, with the message its quote card
 * names apart. `mentionNames` gives each mention's full display name by
 * `itemid`, from the message's `properties.mentions`.
 */
export const teamsHtmlToMarkdown = (
  html: string,
  mentionNames: ReadonlyMap<string, string> = new Map(),
): MessageMarkdown => {
  const root = parseHtml(html);
  const quote = findQuote(root);
  const body = quote ? root.children.filter(child => child !== quote) : root.children;
  return {
    markdown: joinBlocks(renderBlocks(body, { mentionNames })),
    quoted: quote ? quotedMessage(quote) : null,
  };
};
