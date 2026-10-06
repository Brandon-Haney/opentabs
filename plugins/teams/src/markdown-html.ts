// Teams chat messages are sent with `messagetype: 'RichText/Html'`, so the
// `content` field is parsed as an HTML fragment. This module converts a
// message written in Markdown into the exact HTML dialect the Teams web client
// itself emits (decoded from messages composed in the native editor), and lets
// a curated set of inline HTML tags pass through for the formatting Markdown
// cannot express — text colour, highlight, font size, and underline — matching
// what a human can apply from the composer toolbar.
//
// Markdown -> Teams HTML:
//   **bold**      -> <strong>            *italic* / _italic_ -> <i>
//   ~~strike~~    -> <s>                 `code`              -> <code>
//   [text](url)   -> <a href title>      ```fence```         -> <pre><code>
//   - item        -> <ul><li>            1. item             -> <ol><li>
//   indented item -> nested list         indented paragraph  -> <p style="margin-left:40px;">
//   ```sql fence -> <pre class="language-sql language-was-manually-selected">
//   # heading     -> <h1>…<h3>           > quote             -> <blockquote>
//   | a | b |     -> <table>             ---                 -> <hr>
//   paragraph     -> <p>…</p>            soft line break     -> <br>
//   blank line between paragraphs/headings/tables -> <p>&nbsp;</p> spacer, as the composer emits
//
// Inline HTML passthrough (sanitised — every other tag/attribute is escaped):
//   <u>…</u>                                  underline
//   <span style="color:NAME">…</span>         text colour  (NAME is a swatch)
//   <span style="background-color:NAME">…</span> highlight  (NAME is a swatch)
//   <span style="font-size:large|medium|small">…</span> font size
//   <b>/<strong> <i>/<em> <s>/<strike> <code> <a href> <br>
//
// Colour NAMEs are the composer's fixed swatches (red, orange, gold, lime,
// green, teal, blue, magenta); each maps to the exact hex Teams stores. Values
// off the palette are dropped rather than emitted, so a message never carries a
// colour Teams would not render.

/**
 * Shared tool-description blurb documenting the Markdown and inline-HTML
 * formatting `markdownToTeamsHtml` accepts. Kept in one place so send_message
 * and edit_message stay in sync with each other and with the converter.
 */
export const MARKDOWN_FORMATTING_HELP =
  'Text is Markdown, rendered natively: **bold**, *italic*, ~~strike~~, `code`, ```code blocks``` (a language such ' +
  'as ```sql sets the block language), [links](url), "- " and "1. " lists (indent an item to nest it), "# " headings, ' +
  '"> " quotes, "---" rules and pipe tables. Inline HTML adds underline (<u>text</u>), colour ' +
  '(<span style="color:NAME">), highlight (<span style="background-color:NAME">) and size ' +
  '(<span style="font-size:large|medium|small">); NAME is red, orange, gold, lime, green, teal, blue or magenta. A ' +
  'blank line separates paragraphs with a visible gap, a single newline is a line break, and a leading tab or four ' +
  'spaces indents a paragraph one level. Entities such as &nbsp; pass through.';

/** Text-colour swatch name -> exact hex Teams stores. */
const TEXT_COLORS: Record<string, string> = {
  red: '#B6424C',
  orange: '#CD5937',
  gold: '#FDC030',
  lime: '#BDCB4C',
  green: '#2B9B62',
  teal: '#37797B',
  blue: '#1E53A3',
  magenta: '#A5397A',
};

/** Highlight swatch name -> exact hex Teams stores. */
const HIGHLIGHT_COLORS: Record<string, string> = {
  red: '#DF9299',
  orange: '#F4A593',
  gold: '#FDD472',
  lime: '#E5F18F',
  green: '#82CDA8',
  teal: '#9DD9DB',
  blue: '#C7D4E8',
  magenta: '#EBD3E1',
};

/** Font-size name -> CSS value. `medium` is the default and carries no style. */
const FONT_SIZES: Record<string, string | null> = {
  large: 'x-large',
  medium: null,
  small: 'xx-small',
  'x-large': 'x-large',
  'xx-small': 'xx-small',
};

/** Inline formatting tags mapped to the canonical tag name Teams uses. */
const SIMPLE_TAGS: Record<string, string> = {
  u: 'u',
  s: 's',
  strike: 's',
  strong: 'strong',
  b: 'strong',
  i: 'i',
  em: 'i',
  code: 'code',
};

/** HTML-escape text content (element context). */
const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * HTML-escape prose, passing character references (`&nbsp;`, `&#8212;`, `&#x2014;`)
 * through verbatim as CommonMark does. Code spans and fences use `escapeHtml`,
 * where a reference stays literal text.
 */
const escapeProse = (text: string): string =>
  text
    .replace(/&(?!(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** HTML-escape a value for a double-quoted attribute. */
const escapeAttribute = (value: string): string => escapeHtml(value).replace(/"/g, '&quot;');

/** Allow only link schemes Teams renders; anything else (e.g. `javascript:`) is dropped. */
const safeHref = (url: string): string | null => {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
};

/**
 * Resolve a CSS colour value against a palette: a swatch name or the exact
 * palette hex resolves to that hex; `inherit` passes through; anything else is
 * rejected (returns null) so off-palette colours are never emitted. Only own
 * properties count, so keys like `constructor` don't resolve through the prototype.
 */
const resolveColor = (value: string, palette: Record<string, string>): string | null => {
  if (value === 'inherit') return 'inherit';
  if (Object.hasOwn(palette, value)) return palette[value] ?? null;
  const match = Object.values(palette).find(hex => hex.toLowerCase() === value);
  return match ?? null;
};

/** Translate a `<span>` style into the sanitised subset Teams renders (colour, highlight, size). */
const translateStyle = (style: string): string => {
  const declarations: string[] = [];
  let hasColor = false;
  let hasBackground = false;

  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase();

    if (property === 'color') {
      const hex = resolveColor(value, TEXT_COLORS);
      if (hex) {
        declarations.push(`color:${hex}`);
        hasColor = true;
      }
    } else if (property === 'background-color') {
      const hex = resolveColor(value, HIGHLIGHT_COLORS);
      if (hex) {
        declarations.push(`background-color:${hex}`);
        hasBackground = true;
      }
    } else if (property === 'font-size') {
      const size = Object.hasOwn(FONT_SIZES, value) ? FONT_SIZES[value] : undefined;
      if (size) declarations.push(`font-size:${size}`);
    }
  }

  // Teams pairs a highlight with an explicit `color:inherit`; mirror that.
  if (hasBackground && !hasColor) declarations.push('color:inherit');
  return declarations.join('; ');
};

/**
 * Match a whitelisted inline HTML tag at `line[i]`, returning its sanitised
 * form and consumed length, or null if no safe tag matches (the `<` is then
 * treated as literal text and escaped).
 */
const matchInlineTag = (line: string, i: number): { html: string; length: number } | null => {
  const rest = line.slice(i);

  const closing = /^<\/(u|s|strike|strong|b|i|em|code|span|a)>/i.exec(rest);
  if (closing) {
    const name = (closing[1] ?? '').toLowerCase();
    const tag = name === 'span' || name === 'a' ? name : SIMPLE_TAGS[name];
    return { html: `</${tag}>`, length: closing[0].length };
  }

  const styledSpan = /^<span\s+style\s*=\s*"([^"]*)"\s*>/i.exec(rest);
  if (styledSpan) {
    const style = translateStyle(styledSpan[1] ?? '');
    return { html: style ? `<span style="${style}">` : '<span>', length: styledSpan[0].length };
  }

  const plainSpan = /^<span\s*>/i.exec(rest);
  if (plainSpan) return { html: '<span>', length: plainSpan[0].length };

  const anchor = /^<a\s+([^>]*?)>/i.exec(rest);
  if (anchor) {
    const href = safeHref(/href\s*=\s*"([^"]*)"/i.exec(anchor[1] ?? '')?.[1] ?? '');
    if (href !== null) {
      const url = escapeAttribute(href);
      return { html: `<a href="${url}" title="${url}">`, length: anchor[0].length };
    }
    return { html: '<a>', length: anchor[0].length };
  }

  if (/^<br\s*\/?>/i.test(rest)) {
    return { html: '<br>', length: (/^<br\s*\/?>/i.exec(rest)?.[0] ?? '<br>').length };
  }

  const simple = /^<(u|s|strike|strong|b|i|em|code)>/i.exec(rest);
  if (simple) return { html: `<${SIMPLE_TAGS[(simple[1] ?? '').toLowerCase()]}>`, length: simple[0].length };

  return null;
};

/** A run of text with inline marks, or a pre-sanitised HTML fragment emitted verbatim. */
interface Segment {
  text: string;
  marks: Set<string>;
  href?: string;
  raw?: string;
}

/** Whether `char` is a word character (letter, digit, or underscore). */
const isWordChar = (char: string | undefined): boolean => char !== undefined && /\w/.test(char);

/**
 * Whether a `_`/`__` run at `line[i]` is an emphasis delimiter. Following GFM's
 * intraword rule, `_` inside a word (word characters on both sides) is literal,
 * so `snake_case` and `a_b_c` are not italicised; `*`/`**` have no such restriction.
 */
const isUnderscoreDelimiter = (line: string, i: number, length: number): boolean =>
  !(isWordChar(line[i - 1]) && isWordChar(line[i + length]));

/**
 * Parse a single line into inline segments. `**`/`__` toggle bold, `*`/`_`
 * italic, `~~` strikethrough; a backtick span is literal (no inner parsing);
 * `[label](url)` links the label; whitelisted HTML tags pass through sanitised.
 * A delimiter with no matching close stays active, applying its mark to the rest
 * of the line. The input must not contain newlines.
 */
const parseInline = (line: string): Segment[] => {
  const segments: Segment[] = [];
  const active = new Set<string>();
  let buffer = '';

  const flush = (): void => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer, marks: new Set(active) });
    buffer = '';
  };
  const toggle = (mark: string): void => {
    if (active.has(mark)) active.delete(mark);
    else active.add(mark);
  };

  let i = 0;
  while (i < line.length) {
    const two = line.slice(i, i + 2);
    const ch = line[i];

    if (ch === '<') {
      const tag = matchInlineTag(line, i);
      if (tag) {
        flush();
        segments.push({ text: '', marks: new Set(), raw: tag.html });
        i += tag.length;
        continue;
      }
    }
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i) {
        flush();
        segments.push({ text: line.slice(i + 1, end), marks: new Set([...active, 'code']) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = line.indexOf('](', i + 1);
      if (close > i) {
        const urlEnd = line.indexOf(')', close + 2);
        if (urlEnd > close) {
          const url = safeHref(line.slice(close + 2, urlEnd));
          flush();
          for (const segment of parseInline(line.slice(i + 1, close))) {
            segments.push(url === null ? segment : { ...segment, href: url });
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }
    if (two === '**' || (two === '__' && isUnderscoreDelimiter(line, i, 2))) {
      flush();
      toggle('bold');
      i += 2;
      continue;
    }
    if (two === '~~') {
      flush();
      toggle('strike');
      i += 2;
      continue;
    }
    if (ch === '*' || (ch === '_' && isUnderscoreDelimiter(line, i, 1))) {
      flush();
      toggle('italic');
      i += 1;
      continue;
    }

    buffer += ch;
    i++;
  }
  flush();
  return segments;
};

/** Render one segment to HTML: raw passthrough verbatim, else escaped text wrapped in its marks and link. */
const renderSegment = (segment: Segment): string => {
  if (segment.raw !== undefined) return segment.raw;
  const isCode = segment.marks.has('code');
  let html = isCode ? escapeHtml(segment.text) : escapeProse(segment.text);
  if (isCode) html = `<code>${html}</code>`;
  if (segment.marks.has('strike')) html = `<s>${html}</s>`;
  if (segment.marks.has('italic')) html = `<i>${html}</i>`;
  if (segment.marks.has('bold')) html = `<strong>${html}</strong>`;
  if (segment.href !== undefined) {
    const url = escapeAttribute(segment.href);
    html = `<a href="${url}" title="${url}">${html}</a>`;
  }
  return html;
};

/** Render a line's inline Markdown (and passthrough HTML) to an HTML string. */
const renderInline = (line: string): string => parseInline(line).map(renderSegment).join('');

const FENCE = /^\s*```/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
const HORIZONTAL_RULE = /^\s*([-*_])\1{2,}\s*$/;
/** A GFM table separator row, e.g. `| --- | :--: |`. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Whether a line begins an ordered list item (and not a bullet). */
const isOrdered = (line: string): boolean => ORDERED.test(line) && !BULLET.test(line);

/** Whether a line begins a list item of either kind. */
const isListLine = (line: string): boolean => BULLET.test(line) || ORDERED.test(line);

/** Width of a line's leading whitespace in columns, counting a tab as four. */
const indentWidth = (line: string): number => {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
};

/** A list item line: its indentation, its kind, and its rendered content. */
interface ListLine {
  indent: number;
  ordered: boolean;
  html: string;
}

const parseListLine = (line: string): ListLine => {
  const ordered = isOrdered(line);
  return {
    indent: indentWidth(line),
    ordered,
    html: renderInline(line.match(ordered ? ORDERED : BULLET)?.[1] ?? ''),
  };
};

/**
 * Render the list that opens at `items[start]`: its siblings share that item's
 * indent and kind, and each run of more-indented items that follows an item
 * becomes a list nested inside its `<li>`, as the composer's Increase indent
 * produces. Returns the HTML and the index of the first item not consumed.
 */
const renderList = (items: readonly ListLine[], start: number): { html: string; next: number } => {
  const first = items[start];
  if (!first) return { html: '', next: start };
  const tag = first.ordered ? 'ol' : 'ul';
  let html = '';
  let i = start;
  while (i < items.length) {
    const item = items[i];
    if (!item || item.indent !== first.indent || item.ordered !== first.ordered) break;
    i++;
    let nested = '';
    while ((items[i]?.indent ?? -1) > first.indent) {
      const child = renderList(items, i);
      nested += child.html;
      i = child.next;
    }
    html += `<li>${item.html}${nested}</li>`;
  }
  return { html: `<${tag}>${html}</${tag}>`, next: i };
};

/** Left margin Teams adds per Increase indent step on a paragraph. */
const INDENT_STEP_PX = 40;

/** Leading-whitespace columns per paragraph indent level (a tab, or four spaces). */
const COLUMNS_PER_INDENT_LEVEL = 4;

/**
 * Fence info string -> the language id the Teams code-block picker stores as
 * `language-<id>`. Holds every picker language plus common aliases; any other
 * tag renders as plain text.
 */
const CODE_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
  css: 'css',
  dart: 'dart',
  dockerfile: 'dockerFile',
  docker: 'dockerFile',
  dos: 'dos',
  bat: 'dos',
  batch: 'dos',
  cmd: 'dos',
  go: 'go',
  golang: 'go',
  graphql: 'graphql',
  gql: 'graphql',
  html: 'html',
  htm: 'html',
  http: 'http',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsp: 'jsp',
  jsx: 'jsx',
  kotlin: 'kotlin',
  kt: 'kotlin',
  kql: 'kql',
  latex: 'latex',
  tex: 'latex',
  lisp: 'lisp',
  markdown: 'markdown',
  md: 'markdown',
  objectivec: 'objectivec',
  'objective-c': 'objectivec',
  objc: 'objectivec',
  octave: 'octave',
  perl: 'perl',
  pl: 'perl',
  php: 'php',
  powershell: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  python: 'python',
  py: 'python',
  r: 'r',
  ruby: 'ruby',
  rb: 'ruby',
  rust: 'rust',
  rs: 'rust',
  scala: 'scala',
  scss: 'scss',
  sql: 'sql',
  swift: 'swift',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  vbnet: 'vbnet',
  'vb.net': 'vbnet',
  vb: 'vbnet',
  vbscript: 'vbscript',
  vbs: 'vbscript',
  verilog: 'verilog',
  vhdl: 'vhdl',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

/**
 * The `<pre>` class for a fence's info string. A recognised language carries
 * the composer's `language-was-manually-selected` marker, as when a language
 * is picked by hand; anything else is plain text.
 */
const codeBlockClass = (fenceLine: string): string => {
  const tag = (fenceLine.trim().slice(3).trim().split(/\s+/)[0] ?? '').toLowerCase();
  const language = Object.hasOwn(CODE_LANGUAGES, tag) ? CODE_LANGUAGES[tag] : undefined;
  return language ? `language-${language} language-was-manually-selected` : 'language-plaintext';
};

/**
 * The empty paragraph the Teams composer inserts for a blank line. Teams gives
 * `<p>`, headings and tables no vertical margin, so without it consecutive
 * blocks of those kinds render with no gap between them.
 */
const PARAGRAPH_SPACER = '<p>&nbsp;</p>';

/** Whether `line` opens a GFM table: a pipe row immediately followed by a separator row. */
const isTableStart = (line: string, next: string): boolean =>
  line.includes('|') && line.trim() !== '' && TABLE_SEPARATOR.test(next);

/** Whether `line` is a table body row (any non-blank line containing a pipe). */
const isTableRow = (line: string): boolean => line.includes('|') && line.trim() !== '';

/** Split a pipe-delimited row into trimmed cell strings, ignoring the optional edge pipes. */
const tableCells = (line: string): string[] => {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map(cell => cell.trim());
};

/** Render one table row's cells as `<td><p>…</p></td>` (Teams uses no `<th>`). */
const renderTableRow = (line: string): string =>
  `<tr>${tableCells(line)
    .map(cell => `<td><p>${renderInline(cell)}</p></td>`)
    .join('')}</tr>`;

/**
 * Convert Markdown to the HTML dialect Teams expects for a `RichText/Html`
 * message. Blocks are separated by blank lines: a run of text lines becomes a
 * `<p>` (soft line breaks within it become `<br>`); other blocks map to their
 * native tags — headings to `<h1>`–`<h3>`, `>` quotes to `<blockquote>`, pipe
 * tables to `<table>`, `---` to `<hr>`, list items to `<ul>`/`<ol>`, and fences
 * to `<pre><code>`. Inline colour/size/underline HTML passes through sanitised.
 *
 * A blank line between two flush blocks (paragraphs, headings and tables, which
 * Teams renders with no vertical margin) emits `PARAGRAPH_SPACER`, as the
 * composer does; lists, quotes, rules and code blocks carry their own margin.
 * Blank lines between list items keep them in one list, and indented items
 * nest. A fence's language tag selects the Teams code-block language.
 */
export const markdownToTeamsHtml = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let previousIsFlush = false;
  let blankLineSincePrevious = false;
  let i = 0;

  /** Append a block, preceded by a spacer when a blank line separates it from a previous flush block. */
  const emit = (html: string, isFlush: boolean): void => {
    if (isFlush && previousIsFlush && blankLineSincePrevious) blocks.push(PARAGRAPH_SPACER);
    blocks.push(html);
    previousIsFlush = isFlush;
    blankLineSincePrevious = false;
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block
    if (FENCE.test(line)) {
      const className = codeBlockClass(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      emit(`<pre class="${className}"><code>${escapeHtml(body.join('\n'))}</code></pre>`, false);
      continue;
    }

    // Heading (# … ######, clamped to Teams' three native levels)
    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min((heading[1] ?? '').length, 3);
      emit(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`, true);
      i++;
      continue;
    }

    // Horizontal rule (three or more -, *, or _ on their own line)
    if (HORIZONTAL_RULE.test(line)) {
      emit('<hr>', false);
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines)
    if (BLOCKQUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && BLOCKQUOTE.test(lines[i] ?? '')) {
        quoted.push(renderInline((lines[i] ?? '').match(BLOCKQUOTE)?.[1] ?? ''));
        i++;
      }
      emit(`<blockquote><p>${quoted.join('<br>')}</p></blockquote>`, false);
      continue;
    }

    // GFM table (header row, `---` separator, then body rows)
    if (isTableStart(line, lines[i + 1] ?? '')) {
      const rows = [renderTableRow(line)];
      i += 2; // skip the header row and the separator row
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        rows.push(renderTableRow(lines[i] ?? ''));
        i++;
      }
      emit(`<table><tbody>${rows.join('')}</tbody></table>`, true);
      continue;
    }

    // Bulleted / numbered list
    if (isListLine(line)) {
      const items: ListLine[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        if (current.trim() === '') {
          let next = i + 1;
          while (next < lines.length && (lines[next] ?? '').trim() === '') next++;
          if (!isListLine(lines[next] ?? '')) break;
          i = next;
          continue;
        }
        if (!isListLine(current)) break;
        items.push(parseListLine(current));
        i++;
      }
      for (let start = 0; start < items.length; ) {
        const list = renderList(items, start);
        emit(list.html, false);
        start = list.next;
      }
      continue;
    }

    // Blank line — a block separator
    if (line.trim() === '') {
      blankLineSincePrevious = true;
      i++;
      continue;
    }

    // Paragraph — consecutive text lines, soft breaks become <br>; leading
    // whitespace on the first line indents it like the composer's Increase indent
    const indentLevel = Math.floor(indentWidth(line) / COLUMNS_PER_INDENT_LEVEL);
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        HORIZONTAL_RULE.test(current) ||
        BLOCKQUOTE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current) ||
        isTableStart(current, lines[i + 1] ?? '')
      ) {
        break;
      }
      paragraph.push(renderInline(current.trimStart()));
      i++;
    }
    // Breaks closing a paragraph only add vertical space, which PARAGRAPH_SPACER
    // already supplies, so they are dropped; a paragraph of nothing but breaks
    // counts as a blank line.
    const content = paragraph.join('<br>').replace(/(?:\s*<br>)+\s*$/, '');
    if (content === '') {
      blankLineSincePrevious = true;
      continue;
    }
    const open = indentLevel > 0 ? `<p style="margin-left:${indentLevel * INDENT_STEP_PX}px;">` : '<p>';
    emit(`${open}${content}</p>`, true);
  }

  return blocks.join('\n');
};
