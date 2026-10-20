/**
 * Word live formatting: character formatting on matched text, and paragraph
 * formatting, against an OPEN document through the pods engine.
 *
 * Both writes were decoded from the editor's own Home-ribbon gestures (see
 * `plugins/microsoft-word/docs/live-document-model.md`, "The character-formatting
 * write" and "Paragraph formatting"):
 *
 * - Character formatting splits the paragraph's runs at the selection's edges and
 *   points the selected runs at a new character format (`1179649`) holding the
 *   run's existing properties plus the change; the root lists the new format in
 *   `603995325`.
 * - Paragraph formatting resubmits the paragraph with the property set. Applying
 *   a style also clears the paragraph's direct formatting and points its runs at
 *   a cleared format, as the Styles gallery does.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import {
  findPresentationRoot,
  type PodsModel,
  type PodsObject,
  PROP_TEXT,
  readProp,
  refToObjectId,
} from './pods-model.js';
import {
  buildWordRevisionBody,
  findUniqueParagraph,
  listWordParagraphs,
  PROP_CHARACTER_STYLE,
  PROP_PARAGRAPH_STYLE,
  PROP_RUN_BOUNDARIES,
  PROP_RUN_FORMATS,
  PROP_STYLE_NAME,
  paragraphAtIndex,
  RUN_FLAG_PROPS,
  RUN_LIST_PROPS,
  WORD_CLASS_CHAR_FORMAT,
  WORD_CLASS_PARAGRAPH,
  WORD_CLASS_STORY,
  WORD_CLASS_STYLE,
  WORD_STRUCTURE_CLASSES,
  type WordParagraph,
  type WordWriteObject,
  withProperty,
  wordCellIdOf,
  ZERO_REF,
} from './word-live-model.js';
import { findOccurrences } from './word-paragraph-runs.js';

/** The root's list of the character formats introduced by the current editing session. */
export const PROP_ROOT_NEW_FORMATS = 603995325;

export const PROP_BOLD = 134224900;
export const PROP_ITALIC = 134224901;
export const PROP_UNDERLINE = 134224902;
export const PROP_UNDERLINE_STYLE = 201334293;
export const PROP_STRIKETHROUGH = 134224903;
export const PROP_SUPERSCRIPT = 134224904;
export const PROP_SUBSCRIPT = 134224905;
export const PROP_FONT_COLOR = 335551500;
export const PROP_HIGHLIGHT = 335551501;
export const PROP_FONT_SIZE = 268442635;
export const PROP_FONT_NAMES = [469769226, 469777841, 469777842, 469777843, 469777844];
export const PROP_THEME_FONTS = [201341986, 201342446, 201342447, 201342448, 201342449];
/** Set to `1` on every format the editor writes that sets a property. */
export const PROP_FORMAT_SET = 335560228;
export const PROP_LANGUAGE_HINT = 201342000;
/** `true` on the format Clear Formatting writes, and on a paragraph a style cleared. */
export const PROP_FORMATTING_CLEARED = 134233130;

export const PROP_ALIGNMENT = [335551550, 335551620];
export const PROP_INDENT_LEFT = 335559685;
export const PROP_SPACE_BEFORE = 335559738;
export const PROP_SPACE_BEFORE_AUTO = 134233117;
export const PROP_SPACE_AFTER = 335559739;
export const PROP_LINE_SPACING = 335559740;
export const PROP_LINE_SPACING_RULE = 201341983;
export const PROP_SHADING = 335557856;
export const PROP_KEEP_WITH_NEXT = 134245418;
export const PROP_KEEP_LINES_TOGETHER = 134245529;
export const PROP_PAGE_BREAK_BEFORE = 134245659;
/** The colour value meaning "automatic": black on light backgrounds, white on dark. */
export const AUTO_COLOR = '4278190080';

/** Paragraph properties a style replaces, cleared when one is applied. */
const DIRECT_PARAGRAPH_PROPS = [
  ...PROP_ALIGNMENT,
  PROP_INDENT_LEFT,
  PROP_SPACE_BEFORE,
  PROP_SPACE_BEFORE_AUTO,
  PROP_SPACE_AFTER,
  PROP_LINE_SPACING,
  PROP_LINE_SPACING_RULE,
  PROP_SHADING,
];

/** Twips (1/20 pt) in a point. */
const TWIPS_PER_POINT = 20;

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** `#RRGGBB` as Word's colour integer, `0xBBGGRR`; `auto` as the automatic colour. */
export const wordColor = (hex: string): string => {
  if (hex.trim().toLowerCase() === 'auto') return AUTO_COLOR;
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) throw new FrameBridgeValidationError(`"${hex}" is not a colour; pass it as #RRGGBB or auto.`);
  const [, r, g, b] = match as unknown as [string, string, string, string];
  return String((Number.parseInt(b, 16) << 16) | (Number.parseInt(g, 16) << 8) | Number.parseInt(r, 16));
};

const withoutProperties = (properties: (string | number)[], ids: number[]): (string | number)[] => {
  const kept: (string | number)[] = [];
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key === undefined || value === undefined || (typeof key === 'number' && ids.includes(key))) continue;
    kept.push(key, value);
  }
  return kept;
};

const objectById = (model: PodsModel, ref: string): PodsObject | undefined => {
  const id = refToObjectId(ref);
  return id ? model.objects.find(o => o.objectId === id) : undefined;
};

/**
 * Whether a run's format reference is plain text formatting this module may
 * change: the empty reference, or a character format. A run pointing anywhere
 * else is a field character (a hyperlink's code or end marker) and is left alone.
 */
const isFormattableRef = (model: PodsModel, ref: string): boolean =>
  ref === ZERO_REF || objectById(model, ref)?.classId === WORD_CLASS_CHAR_FORMAT;

/** Whether a run's format names a character style (the Hyperlink style, for one) or is no format at all. */
export const namesCharacterStyle = (model: PodsModel, ref: string): boolean => {
  const format = objectById(model, ref);
  if (ref === ZERO_REF) return false;
  return format?.classId !== WORD_CLASS_CHAR_FORMAT || readProp(format.properties, PROP_CHARACTER_STYLE) !== undefined;
};

const parseBoundaries = (value: string | undefined): number[] =>
  value === undefined || value.length === 0 ? [] : value.split(',').map(Number);

interface Span {
  start: number;
  end: number;
  /** The index of the original run this span was cut from. */
  run: number;
}

const resolveTarget = (model: PodsModel, args: { anchor?: string; index?: number }, role: string): WordParagraph => {
  const paragraphs = listWordParagraphs(model);
  return args.index !== undefined
    ? paragraphAtIndex(paragraphs, args.index)
    : findUniqueParagraph(paragraphs, args.anchor as string, role);
};

const optionalIndex = (raw: Record<string, unknown>, action: string): number | undefined => {
  if (raw.index === undefined) return undefined;
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 1) {
    throw new FrameBridgeValidationError(`${action} \`index\` must be a positive integer.`);
  }
  return raw.index;
};

const optionalNumber = (raw: Record<string, unknown>, key: string, action: string, min: number, max: number) => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new FrameBridgeValidationError(`${action} \`${key}\` must be a number from ${min} to ${max}.`);
  }
  return value;
};

const optionalBoolean = (raw: Record<string, unknown>, key: string, action: string): boolean | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new FrameBridgeValidationError(`${action} \`${key}\` must be a boolean.`);
  return value;
};

const optionalString = (raw: Record<string, unknown>, key: string, action: string): string | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FrameBridgeValidationError(`${action} \`${key}\` must be a non-empty string.`);
  }
  return value;
};

// ---------------------------------------------------------------------------
// character formatting
// ---------------------------------------------------------------------------

/** The character formatting a call sets; an absent field is left as it is. */
export interface CharacterChanges {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  /** `#RRGGBB`. */
  color?: string;
  /** `#RRGGBB`. */
  highlight?: string;
  /** Points. */
  size?: number;
  font?: string;
}

/** The property values a set of changes writes onto a character format, as `[id, value]` pairs. */
export const characterProperties = (changes: CharacterChanges): [number, string][] => {
  const set: [number, string][] = [];
  const flag = (id: number, on: boolean | undefined) => {
    if (on !== undefined) set.push([id, String(on)]);
  };
  flag(PROP_BOLD, changes.bold);
  flag(PROP_ITALIC, changes.italic);
  flag(PROP_UNDERLINE, changes.underline);
  if (changes.underline === true) set.push([PROP_UNDERLINE_STYLE, '0']);
  flag(PROP_STRIKETHROUGH, changes.strikethrough);
  flag(PROP_SUPERSCRIPT, changes.superscript);
  flag(PROP_SUBSCRIPT, changes.subscript);
  if (changes.superscript === true) set.push([PROP_SUBSCRIPT, 'false']);
  if (changes.subscript === true) set.push([PROP_SUPERSCRIPT, 'false']);
  if (changes.color !== undefined) set.push([PROP_FONT_COLOR, wordColor(changes.color)]);
  if (changes.highlight !== undefined) set.push([PROP_HIGHLIGHT, wordColor(changes.highlight)]);
  if (changes.size !== undefined) set.push([PROP_FONT_SIZE, String(Math.round(changes.size * 2))]);
  if (changes.font !== undefined) {
    for (const id of PROP_FONT_NAMES) set.push([id, changes.font]);
    for (const id of PROP_THEME_FONTS) set.push([id, '-1']);
  }
  return set;
};

/** The properties of the format Clear Formatting writes. */
const CLEARED_FORMAT: (string | number)[] = [PROP_LANGUAGE_HINT, '0', PROP_FORMATTING_CLEARED, 'true'];

/**
 * A new character format: the base format's properties with the changes applied,
 * or the cleared format. The base's own clear marker does not carry into a format
 * that sets something.
 */
export const derivedFormat = (base: (string | number)[], changes: CharacterChanges | 'clear'): (string | number)[] => {
  if (changes === 'clear') return [...CLEARED_FORMAT];
  let properties = withoutProperties(base, [PROP_FORMATTING_CLEARED]);
  properties = withProperty(properties, PROP_FORMAT_SET, '1');
  if (readProp(properties, PROP_LANGUAGE_HINT) === undefined) properties.push(PROP_LANGUAGE_HINT, '0');
  for (const [id, value] of characterProperties(changes)) properties = withProperty(properties, id, value);
  return properties;
};

/**
 * A paragraph's properties with the runs inside `ranges` pointed at new formats.
 *
 * Runs are split at every range edge; each span keeps every per-run entry of the
 * run it was cut from, except that a span inside a range takes `remap(ref)` for
 * its format. Spans whose format is not a character format (field characters)
 * keep their reference.
 */
export const formatRanges = (
  properties: (string | number)[],
  ranges: [number, number][],
  remap: (ref: string) => string | undefined,
): (string | number)[] => {
  const text = readProp(properties, PROP_TEXT) ?? '';
  const boundaries = parseBoundaries(readProp(properties, PROP_RUN_BOUNDARIES));
  const runCount = boundaries.length + 1;
  const cuts = new Set(boundaries);
  for (const [start, end] of ranges) {
    if (start > 0) cuts.add(start);
    if (end < text.length) cuts.add(end);
  }
  const edges = [...cuts].filter(c => c > 0 && c < text.length).sort((a, b) => a - b);
  const runAt = (offset: number): number => boundaries.filter(b => b <= offset).length;
  const starts = [0, ...edges];
  const spans: Span[] = starts.map((start, i) => ({ start, end: edges[i] ?? text.length, run: runAt(start) }));
  const inRange = (span: Span) => ranges.some(([start, end]) => span.start >= start && span.end <= end);

  const rewritten: (string | number)[] = [];
  let wroteBoundaries = false;
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_RUN_BOUNDARIES) {
      if (edges.length > 0) rewritten.push(key, edges.join(','));
      wroteBoundaries = true;
    } else if (
      typeof key === 'number' &&
      RUN_FLAG_PROPS.includes(key) &&
      typeof value === 'string' &&
      value.length === runCount
    ) {
      rewritten.push(key, spans.map(span => value[span.run]).join(''));
    } else if (typeof key === 'number' && RUN_LIST_PROPS.includes(key) && typeof value === 'string') {
      const entries = value.length === 0 ? [] : value.split(',');
      if (entries.length !== runCount) {
        rewritten.push(key, value);
        continue;
      }
      rewritten.push(
        key,
        spans
          .map(span => {
            const entry = entries[span.run] as string;
            return key === PROP_RUN_FORMATS && inRange(span) ? (remap(entry) ?? entry) : entry;
          })
          .join(','),
      );
    } else {
      rewritten.push(key, value);
    }
  }
  if (!wroteBoundaries && edges.length > 0) rewritten.push(PROP_RUN_BOUNDARIES, edges.join(','));
  return rewritten;
};

export interface WordFormatTextArgs {
  /** Text to format; absent to format a whole paragraph named by `index`/`anchor`. */
  find?: string;
  /** Format every occurrence of `find`; otherwise it must occur once. */
  all: boolean;
  index?: number;
  anchor?: string;
  changes: CharacterChanges | 'clear';
}

interface FormatTarget {
  paragraph: WordParagraph;
  ranges: [number, number][];
}

export interface WordFormatTextContext {
  targets: FormatTarget[];
  cellId: string;
  root: PodsObject;
  /** The format each run's existing format reference is replaced with, keyed by the old reference. */
  bases: Map<string, (string | number)[]>;
}

const resolveFormatText = (model: PodsModel, args: WordFormatTextArgs): WordFormatTextContext => {
  let targets: FormatTarget[];
  if (args.find === undefined) {
    const paragraph = resolveTarget(model, args, 'paragraph to format');
    targets = [{ paragraph, ranges: [[0, paragraph.text.length]] }];
  } else {
    const find = args.find;
    const scope =
      args.index !== undefined || args.anchor !== undefined
        ? [resolveTarget(model, args, 'paragraph to format in')]
        : listWordParagraphs(model);
    targets = scope
      .map(paragraph => ({
        paragraph,
        ranges: findOccurrences(paragraph.text, find).map((at): [number, number] => [at, at + find.length]),
      }))
      .filter(t => t.ranges.length > 0);
    const total = targets.reduce((sum, t) => sum + t.ranges.length, 0);
    if (total === 0) {
      throw new FrameBridgeValidationError(
        `"${find}" does not occur in the ${scope.length === 1 ? 'paragraph' : 'document'}. Text is matched within ` +
          'one paragraph, exactly as written (case-sensitive); read the live document to copy it verbatim.',
      );
    }
    if (!args.all && total > 1) {
      throw new FrameBridgeValidationError(
        `"${find}" occurs ${total} times (paragraphs ${targets.map(t => `#${t.paragraph.index}`).join(', ')}). ` +
          'Pass more surrounding text, name the paragraph with index, or pass all: true to format every one.',
      );
    }
  }
  if (targets.every(t => t.ranges.every(([start, end]) => start === end))) {
    throw new FrameBridgeValidationError('The paragraph has no text to format.');
  }

  const cells = new Set(targets.map(t => wordCellIdOf(model, t.paragraph.paragraph)));
  if (cells.size > 1) {
    throw new FrameBridgeValidationError(
      'The matches lie in more than one storage cell of the document; format them one paragraph at a time.',
    );
  }

  const bases = new Map<string, (string | number)[]>();
  for (const target of targets) {
    const runs = (readProp(target.paragraph.paragraph.properties, PROP_RUN_FORMATS) ?? '').split(',');
    for (const ref of runs) {
      if (ref.length === 0 || bases.has(ref) || !isFormattableRef(model, ref)) continue;
      bases.set(ref, objectById(model, ref)?.properties ?? []);
    }
  }
  return {
    targets,
    cellId: [...cells][0] as string,
    root: findPresentationRoot(model),
    bases,
  };
};

/** The new formats a format write creates, one per distinct base, each in its own object slot. */
const newFormats = (ctx: WordFormatTextContext, args: WordFormatTextArgs, guidToken: string) => {
  const byBase = new Map<string, { ref: string; object: WordWriteObject }>();
  let slot = 3;
  for (const [baseRef, baseProperties] of ctx.bases) {
    byBase.set(baseRef, {
      ref: `{${guidToken}}{${slot}}`,
      object: {
        ObjectId: `${guidToken}|${slot}`,
        ClassId: WORD_CLASS_CHAR_FORMAT,
        Properties: derivedFormat(baseProperties, args.changes),
      },
    });
    slot += 1;
  }
  return byBase;
};

export const buildWordFormatTextBody = (
  ctx: WordFormatTextContext,
  args: WordFormatTextArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  const formats = newFormats(ctx, args, mint.guidToken);
  const paragraphs: WordWriteObject[] = ctx.targets.map(t => ({
    ObjectId: t.paragraph.paragraph.objectId,
    ClassId: WORD_CLASS_PARAGRAPH,
    Properties: formatRanges(t.paragraph.paragraph.properties, t.ranges, ref => formats.get(ref)?.ref),
  }));
  const listed = readProp(ctx.root.properties, PROP_ROOT_NEW_FORMATS);
  const added = [...formats.values()].map(f => f.ref);
  const root: WordWriteObject = {
    ObjectId: ctx.root.objectId,
    ClassId: ctx.root.classId,
    Properties: withProperty(ctx.root.properties, PROP_ROOT_NEW_FORMATS, [listed, ...added].filter(Boolean).join(',')),
  };
  return buildWordRevisionBody(
    [root, ...paragraphs, ...[...formats.values()].map(f => f.object)],
    ctx.cellId,
    mint.guidToken,
    mint.headToken,
  );
};

/** Whether a format carries every property the changes set. */
const formatCarries = (format: PodsObject | undefined, changes: CharacterChanges | 'clear'): boolean => {
  if (!format) return false;
  const expected: [number, string][] =
    changes === 'clear' ? [[PROP_FORMATTING_CLEARED, 'true']] : characterProperties(changes);
  return expected.every(([id, value]) => readProp(format.properties, id) === value);
};

/**
 * Applied when, in each target paragraph (found by its id), every run covering a
 * formatted range points at a format carrying the change.
 */
const isFormatTextApplied = (model: PodsModel, first: WordFormatTextContext, args: WordFormatTextArgs): boolean =>
  first.targets.every(target => {
    const paragraph = model.objects.find(o => o.objectId === target.paragraph.paragraph.objectId);
    if (!paragraph) return false;
    const text = readProp(paragraph.properties, PROP_TEXT) ?? '';
    if (text !== target.paragraph.text) return false;
    const boundaries = parseBoundaries(readProp(paragraph.properties, PROP_RUN_BOUNDARIES));
    const refs = (readProp(paragraph.properties, PROP_RUN_FORMATS) ?? '').split(',');
    const starts = [0, ...boundaries];
    return target.ranges.every(([start, end]) =>
      starts.every((runStart, run) => {
        const runEnd = boundaries[run] ?? text.length;
        const overlaps = runStart < end && runEnd > start;
        const ref = refs[run] ?? '';
        if (!overlaps || !isFormattableRef(model, ref)) return true;
        return formatCarries(objectById(model, ref), args.changes);
      }),
    );
  });

const parseCharacterChanges = (raw: Record<string, unknown>, action: string): CharacterChanges | 'clear' => {
  if (raw.clear === true) return 'clear';
  if (raw.clear !== undefined && raw.clear !== false) {
    throw new FrameBridgeValidationError(`${action} \`clear\` must be a boolean.`);
  }
  const changes: CharacterChanges = {
    bold: optionalBoolean(raw, 'bold', action),
    italic: optionalBoolean(raw, 'italic', action),
    underline: optionalBoolean(raw, 'underline', action),
    strikethrough: optionalBoolean(raw, 'strikethrough', action),
    superscript: optionalBoolean(raw, 'superscript', action),
    subscript: optionalBoolean(raw, 'subscript', action),
    color: optionalString(raw, 'color', action),
    highlight: optionalString(raw, 'highlight', action),
    size: optionalNumber(raw, 'size', action, 1, 1638),
    font: optionalString(raw, 'font', action),
  };
  if (changes.superscript === true && changes.subscript === true) {
    throw new FrameBridgeValidationError(`${action} cannot set both superscript and subscript.`);
  }
  if (changes.color !== undefined) wordColor(changes.color);
  if (changes.highlight?.trim().toLowerCase() === 'auto') {
    throw new FrameBridgeValidationError(`${action} \`highlight\` takes a colour as #RRGGBB.`);
  }
  if (changes.highlight !== undefined) wordColor(changes.highlight);
  if (Object.values(changes).every(v => v === undefined)) {
    throw new FrameBridgeValidationError(
      `${action} needs a change: bold, italic, underline, strikethrough, superscript, subscript, color, highlight, ` +
        'size or font — or clear: true.',
    );
  }
  return changes;
};

/** The `word_format_text` action: character formatting on matched text or a whole paragraph. */
export const wordFormatTextAction: PodsWriteActionSpec<WordFormatTextArgs, WordFormatTextContext> = {
  kind: 'write',
  classFilter: [...WORD_STRUCTURE_CLASSES, WORD_CLASS_CHAR_FORMAT],
  parseArgs: raw => {
    const action = 'word_format_text';
    const find = raw.find === undefined ? undefined : optionalString(raw, 'find', action);
    if (find !== undefined && /[\r\n]/.test(find)) {
      throw new FrameBridgeValidationError(`${action} \`find\` is matched within one paragraph; drop the line breaks.`);
    }
    const index = optionalIndex(raw, action);
    const anchor = index === undefined ? optionalString(raw, 'anchor', action) : undefined;
    if (find === undefined && index === undefined && anchor === undefined) {
      throw new FrameBridgeValidationError(`${action} needs \`find\` (text to format), or a paragraph (index/anchor).`);
    }
    return {
      find,
      all: optionalBoolean(raw, 'all', action) === true,
      index,
      anchor,
      changes: parseCharacterChanges(raw, action),
    };
  },
  resolve: resolveFormatText,
  build: buildWordFormatTextBody,
  isApplied: isFormatTextApplied,
  // Re-applying the same formatting yields the same document.
  idempotent: true,
  compactDryRun: true,
  summarize: (ctx, args) => ({
    formatted: ctx.targets.reduce((sum, t) => sum + t.ranges.length, 0),
    paragraphs: ctx.targets.map(t => ({ index: t.paragraph.index, text: t.paragraph.text })),
    cleared: args.changes === 'clear',
  }),
  dryRunExtras: ctx => ({ paragraphs: ctx.targets.map(t => ({ index: t.paragraph.index, ranges: t.ranges })) }),
};

// ---------------------------------------------------------------------------
// paragraph formatting
// ---------------------------------------------------------------------------

export const ALIGNMENTS = { center: '2', right: '3', justify: '6' } as const;

export interface ParagraphChanges {
  /** `left` removes the paragraph's own alignment, so it follows its style (left in every built-in body style). */
  alignment?: 'left' | 'center' | 'right' | 'justify';
  /** Left indent in points. */
  indentLeft?: number;
  /** Points. */
  spaceBefore?: number;
  /** Points. */
  spaceAfter?: number;
  /** Line spacing as a multiple of single spacing (1, 1.15, 1.5, 2). */
  lineSpacing?: number;
  /** `#RRGGBB`, or `none` to remove shading. */
  shading?: string;
  /** A paragraph style already defined in the document, by name (case-insensitive). */
  style?: string;
  /** Keep the paragraph on the same page as the next one. */
  keepWithNext?: boolean;
  /** Keep the paragraph's lines on one page. */
  keepLinesTogether?: boolean;
  /** Start the paragraph on a new page. */
  pageBreakBefore?: boolean;
}

export interface WordFormatParagraphArgs extends ParagraphChanges {
  index?: number;
  anchor?: string;
}

export interface WordFormatParagraphContext {
  target: WordParagraph;
  cellId: string;
  root: PodsObject;
  /** The style to apply, when `style` was named. */
  style?: AppliedStyle;
}

/** A style a paragraph format applies, and the story that must list it as used. */
interface AppliedStyle {
  ref: string;
  name: string;
  story: PodsObject;
}

/** The story's list of the styles the document uses, by reference. */
const PROP_STORY_STYLES = 603993304;
/** The story's list of the names of styles applied in this editing session, as a JSON array. */
const PROP_STORY_STYLE_NAMES = 469789709;

/**
 * The story with `style` listed as used, as the editor writes it the first time a
 * style is applied — or undefined when it already lists it. A paragraph pointing
 * at a style its story does not list renders unstyled and loses the style on save.
 */
export const storyListingStyle = (style: AppliedStyle): (string | number)[] | undefined => {
  const listed = (readProp(style.story.properties, PROP_STORY_STYLES) ?? '').split(',').filter(Boolean);
  if (listed.includes(style.ref)) return undefined;
  let names: string[] = [];
  try {
    const parsed = JSON.parse(readProp(style.story.properties, PROP_STORY_STYLE_NAMES) ?? '[]');
    if (Array.isArray(parsed)) names = parsed.filter((n): n is string => typeof n === 'string');
  } catch {
    names = [];
  }
  let properties = withProperty(style.story.properties, PROP_STORY_STYLES, [...listed, style.ref].join(','));
  if (!names.includes(style.name)) {
    properties = withProperty(properties, PROP_STORY_STYLE_NAMES, JSON.stringify([...names, style.name]));
  }
  return properties;
};

const styleByName = (model: PodsModel, name: string): AppliedStyle => {
  const wanted = name.trim().toLowerCase();
  const styles = model.objects.filter(o => o.classId === WORD_CLASS_STYLE);
  const found = styles.find(s => (readProp(s.properties, PROP_STYLE_NAME) ?? '').toLowerCase() === wanted);
  if (!found) {
    const names = [...new Set(styles.map(s => readProp(s.properties, PROP_STYLE_NAME)).filter(Boolean))].sort();
    throw new FrameBridgeValidationError(
      `The document defines no style named "${name}"` +
        (names.length > 0 ? ` (styles in it: ${names.slice(0, 30).join(', ')})` : '') +
        '. A built-in style is added to a document the first time someone applies it in Word.',
    );
  }
  const story = model.objects.find(o => o.classId === WORD_CLASS_STORY);
  if (!story) throw new FrameBridgeValidationError('The live model named no document story to list the style in.');
  const [guid, slot] = found.objectId.split('|');
  return { ref: `{${guid}}{${slot}}`, name: readProp(found.properties, PROP_STYLE_NAME) ?? name, story };
};

/** The `[id, value]` pairs a set of paragraph changes writes, and the ids it removes. */
export const paragraphProperties = (changes: ParagraphChanges): { set: [number, string][]; remove: number[] } => {
  const set: [number, string][] = [];
  const remove: number[] = [];
  if (changes.alignment === 'left') remove.push(...PROP_ALIGNMENT);
  else if (changes.alignment !== undefined) {
    for (const id of PROP_ALIGNMENT) set.push([id, ALIGNMENTS[changes.alignment]]);
  }
  if (changes.indentLeft !== undefined) {
    set.push([PROP_INDENT_LEFT, String(Math.round(changes.indentLeft * TWIPS_PER_POINT))]);
  }
  if (changes.spaceBefore !== undefined) {
    set.push([PROP_SPACE_BEFORE, String(Math.round(changes.spaceBefore * TWIPS_PER_POINT))]);
    set.push([PROP_SPACE_BEFORE_AUTO, 'false']);
  }
  if (changes.spaceAfter !== undefined) {
    set.push([PROP_SPACE_AFTER, String(Math.round(changes.spaceAfter * TWIPS_PER_POINT))]);
  }
  if (changes.lineSpacing !== undefined) {
    set.push([PROP_LINE_SPACING, String(Math.round(changes.lineSpacing * 240))]);
    set.push([PROP_LINE_SPACING_RULE, '0']);
  }
  if (changes.shading === 'none') remove.push(PROP_SHADING);
  else if (changes.shading !== undefined) set.push([PROP_SHADING, wordColor(changes.shading)]);
  const flags: [number, boolean | undefined][] = [
    [PROP_KEEP_WITH_NEXT, changes.keepWithNext],
    [PROP_KEEP_LINES_TOGETHER, changes.keepLinesTogether],
    [PROP_PAGE_BREAK_BEFORE, changes.pageBreakBefore],
  ];
  for (const [id, on] of flags) if (on !== undefined) set.push([id, String(on)]);
  return { set, remove };
};

export const buildWordFormatParagraphBody = (
  ctx: WordFormatParagraphContext,
  args: WordFormatParagraphArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  let properties = ctx.target.paragraph.properties;
  const objects: WordWriteObject[] = [];
  if (ctx.style !== undefined) {
    // As the Styles gallery does: the style replaces the paragraph's direct
    // formatting, its runs point at a cleared format, and the story lists the
    // style as used.
    const clearedRef = `{${mint.guidToken}}{3}`;
    const story = storyListingStyle(ctx.style);
    if (story) objects.push({ ObjectId: ctx.style.story.objectId, ClassId: WORD_CLASS_STORY, Properties: story });
    properties = withoutProperties(properties, DIRECT_PARAGRAPH_PROPS);
    properties = withProperty(properties, PROP_PARAGRAPH_STYLE, ctx.style.ref);
    properties = withProperty(properties, PROP_FORMATTING_CLEARED, 'true');
    properties = formatRanges(properties, [[0, ctx.target.text.length]], () => clearedRef);
    objects.push({ ObjectId: `${mint.guidToken}|3`, ClassId: WORD_CLASS_CHAR_FORMAT, Properties: [...CLEARED_FORMAT] });
    const listed = readProp(ctx.root.properties, PROP_ROOT_NEW_FORMATS);
    objects.unshift({
      ObjectId: ctx.root.objectId,
      ClassId: ctx.root.classId,
      Properties: withProperty(
        ctx.root.properties,
        PROP_ROOT_NEW_FORMATS,
        [listed, clearedRef].filter(Boolean).join(','),
      ),
    });
  }
  const { set, remove } = paragraphProperties(args);
  properties = withoutProperties(properties, remove);
  for (const [id, value] of set) properties = withProperty(properties, id, value);
  objects.push({ ObjectId: ctx.target.paragraph.objectId, ClassId: WORD_CLASS_PARAGRAPH, Properties: properties });
  return buildWordRevisionBody(objects, ctx.cellId, mint.guidToken, mint.headToken);
};

const parseParagraphChanges = (raw: Record<string, unknown>, action: string): ParagraphChanges => {
  const alignment = raw.alignment;
  if (alignment !== undefined && !['left', 'center', 'right', 'justify'].includes(alignment as string)) {
    throw new FrameBridgeValidationError(`${action} \`alignment\` must be left, center, right or justify.`);
  }
  const shading = optionalString(raw, 'shading', action);
  if (shading !== undefined && shading !== 'none') wordColor(shading);
  const changes: ParagraphChanges = {
    alignment: alignment as ParagraphChanges['alignment'],
    indentLeft: optionalNumber(raw, 'indentLeft', action, 0, 1584),
    spaceBefore: optionalNumber(raw, 'spaceBefore', action, 0, 1584),
    spaceAfter: optionalNumber(raw, 'spaceAfter', action, 0, 1584),
    lineSpacing: optionalNumber(raw, 'lineSpacing', action, 0.5, 10),
    shading,
    style: optionalString(raw, 'style', action),
    keepWithNext: optionalBoolean(raw, 'keepWithNext', action),
    keepLinesTogether: optionalBoolean(raw, 'keepLinesTogether', action),
    pageBreakBefore: optionalBoolean(raw, 'pageBreakBefore', action),
  };
  if (Object.values(changes).every(v => v === undefined)) {
    throw new FrameBridgeValidationError(
      `${action} needs a change: alignment, indentLeft, spaceBefore, spaceAfter, lineSpacing, shading, style, ` +
        'keepWithNext, keepLinesTogether or pageBreakBefore.',
    );
  }
  return changes;
};

/** Applied when the paragraph (found by its id) carries every property set and none removed. */
const isFormatParagraphApplied = (
  model: PodsModel,
  first: WordFormatParagraphContext,
  args: WordFormatParagraphArgs,
): boolean => {
  const paragraph = model.objects.find(o => o.objectId === first.target.paragraph.objectId);
  if (!paragraph) return false;
  const { set, remove } = paragraphProperties(args);
  if (!set.every(([id, value]) => readProp(paragraph.properties, id) === value)) return false;
  if (!remove.every(id => readProp(paragraph.properties, id) === undefined)) return false;
  return first.style === undefined || readProp(paragraph.properties, PROP_PARAGRAPH_STYLE) === first.style.ref;
};

/** The `word_format_paragraph` action: alignment, indent, spacing, shading and style of one paragraph. */
export const wordFormatParagraphAction: PodsWriteActionSpec<WordFormatParagraphArgs, WordFormatParagraphContext> = {
  kind: 'write',
  classFilter: [...WORD_STRUCTURE_CLASSES, WORD_CLASS_STYLE],
  parseArgs: raw => {
    const action = 'word_format_paragraph';
    const index = optionalIndex(raw, action);
    const anchor = index === undefined ? optionalString(raw, 'anchor', action) : undefined;
    if (index === undefined && anchor === undefined) {
      throw new FrameBridgeValidationError(`${action} needs \`anchor\` (paragraph text) or \`index\`.`);
    }
    return { index, anchor, ...parseParagraphChanges(raw, action) };
  },
  resolve: (model, args) => {
    const target = resolveTarget(model, args, 'paragraph to format');
    return {
      target,
      cellId: wordCellIdOf(model, target.paragraph),
      root: findPresentationRoot(model),
      style: args.style === undefined ? undefined : styleByName(model, args.style),
    };
  },
  build: buildWordFormatParagraphBody,
  isApplied: isFormatParagraphApplied,
  idempotent: true,
  compactDryRun: true,
  summarize: ctx => ({ index: ctx.target.index, text: ctx.target.text }),
  dryRunExtras: ctx => ({ index: ctx.target.index }),
};
