/**
 * Word live formatting readout: what each paragraph of an OPEN document looks
 * like — its style and paragraph formatting, and its text as runs carrying their
 * character formatting and links — read through the pods engine.
 *
 * The property ids are those the formatting writes set (`word-formatting.ts`),
 * decoded from the editor's own gestures. Only what a paragraph or run sets for
 * itself is reported; formatting it inherits from its style is not.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsReadActionSpec } from './pods-actions.js';
import { type PodsModel, type PodsObject, PROP_TEXT, readProp, refToObjectId } from './pods-model.js';
import {
  ALIGNMENTS,
  AUTO_COLOR,
  PROP_ALIGNMENT,
  PROP_BOLD,
  PROP_FONT_COLOR,
  PROP_FONT_NAMES,
  PROP_FONT_SIZE,
  PROP_HIGHLIGHT,
  PROP_INDENT_LEFT,
  PROP_ITALIC,
  PROP_KEEP_LINES_TOGETHER,
  PROP_KEEP_WITH_NEXT,
  PROP_LINE_SPACING,
  PROP_PAGE_BREAK_BEFORE,
  PROP_SHADING,
  PROP_SPACE_AFTER,
  PROP_SPACE_BEFORE,
  PROP_STRIKETHROUGH,
  PROP_SUBSCRIPT,
  PROP_SUPERSCRIPT,
  PROP_UNDERLINE,
} from './word-formatting.js';
import {
  listWordParagraphs,
  PROP_CHARACTER_STYLE,
  PROP_LIST_ID,
  PROP_LIST_LEVEL,
  PROP_PARAGRAPH_STYLE,
  PROP_RUN_BOUNDARIES,
  PROP_RUN_FORMATS,
  PROP_STYLE_NAME,
  WORD_CLASS_CHAR_FORMAT,
  WORD_CLASS_STYLE,
  WORD_STRUCTURE_CLASSES,
} from './word-live-model.js';

/** A field character or list level: the class a field's placeholder runs point at. */
const WORD_CLASS_FIELD_CHARACTER = 131073;
/** A field character's role: `17` ends the field. */
const PROP_FIELD_CHARACTER_KIND = 335559696;
const FIELD_END = '17';
/** The field code a field's first characters carry, e.g. `HYPERLINK "https://…" `. */
const PROP_FIELD_CODE = 469777596;
/** The character every field character occupies in a paragraph's text. */
const FIELD_PLACEHOLDER = '￼';

/** Paragraphs one readout reports before capping. */
const MAX_PARAGRAPHS = 200;
const TWIPS_PER_POINT = 20;

/** Character formatting as a run sets it; an absent field is not set on the run. */
export interface RunFormatting {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  /** `#RRGGBB`, or `auto` for the automatic colour. */
  color?: string;
  /** `#RRGGBB`. */
  highlight?: string;
  /** Points. */
  size?: number;
  font?: string;
  /** The character style the run names, such as "Hyperlink". */
  characterStyle?: string;
  /** The address of the link the run is the text of. */
  link?: string;
}

export interface ParagraphFormatting {
  index: number;
  text: string;
  /** The paragraph style's name; null when the paragraph names none (it follows the document default). */
  style: string | null;
  alignment?: string;
  /** Points. */
  indentLeft?: number;
  /** Points. */
  spaceBefore?: number;
  /** Points. */
  spaceAfter?: number;
  /** A multiple of single spacing. */
  lineSpacing?: number;
  /** `#RRGGBB`. */
  shading?: string;
  /** List level (0 = top) of a Word list item. */
  listLevel?: number;
  keepWithNext?: boolean;
  keepLinesTogether?: boolean;
  pageBreakBefore?: boolean;
  runs: RunFormatting[];
}

/** Word's colour integer, `0xBBGGRR`, as `#RRGGBB`. */
export const hexColor = (value: string): string | undefined => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffff) return undefined;
  const hex = (shift: number) => ((n >> shift) & 0xff).toString(16).padStart(2, '0');
  return `#${hex(0)}${hex(8)}${hex(16)}`.toUpperCase();
};

const byIdIndex = (model: PodsModel): Map<string, PodsObject> => new Map(model.objects.map(o => [o.objectId, o]));

const lookup = (byId: Map<string, PodsObject>, ref: string | undefined): PodsObject | undefined => {
  const id = ref ? refToObjectId(ref) : null;
  return id ? byId.get(id) : undefined;
};

/** The address a `HYPERLINK` field code points at. */
export const linkTarget = (code: string): string | undefined => /HYPERLINK\s+"([^"]*)"/i.exec(code)?.[1];

/** A character format's settings, in the readout's terms. */
const characterSettings = (byId: Map<string, PodsObject>, format: PodsObject): Omit<RunFormatting, 'text' | 'link'> => {
  const p = format.properties;
  const flag = (id: number) => {
    const value = readProp(p, id);
    return value === undefined ? undefined : value === 'true';
  };
  const color = readProp(p, PROP_FONT_COLOR);
  const highlight = readProp(p, PROP_HIGHLIGHT);
  const size = readProp(p, PROP_FONT_SIZE);
  const styleName = readProp(lookup(byId, readProp(p, PROP_CHARACTER_STYLE))?.properties ?? [], PROP_STYLE_NAME);
  return {
    bold: flag(PROP_BOLD),
    italic: flag(PROP_ITALIC),
    underline: flag(PROP_UNDERLINE),
    strikethrough: flag(PROP_STRIKETHROUGH),
    superscript: flag(PROP_SUPERSCRIPT),
    subscript: flag(PROP_SUBSCRIPT),
    color: color === undefined ? undefined : color === AUTO_COLOR ? 'auto' : hexColor(color),
    highlight: highlight === undefined || highlight === AUTO_COLOR ? undefined : hexColor(highlight),
    size: size === undefined ? undefined : Number(size) / 2,
    font: readProp(p, PROP_FONT_NAMES[1] as number) ?? readProp(p, PROP_FONT_NAMES[0] as number),
    characterStyle: styleName,
  };
};

/** Drop the fields a run does not set, so the readout lists only what is there. */
const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

const sameFormatting = (a: RunFormatting, b: RunFormatting): boolean => {
  const { text: _a, ...restA } = a;
  const { text: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
};

/**
 * A paragraph's text as runs with their formatting. Field characters are not
 * text: they are dropped, and the text between a `HYPERLINK` field's code and its
 * end is reported as the link's text, with its address. Neighbouring runs that
 * read the same are merged.
 */
export const paragraphRuns = (byId: Map<string, PodsObject>, paragraph: PodsObject): RunFormatting[] => {
  const text = readProp(paragraph.properties, PROP_TEXT) ?? '';
  const boundaries = (readProp(paragraph.properties, PROP_RUN_BOUNDARIES) ?? '').split(',').filter(Boolean).map(Number);
  const refs = (readProp(paragraph.properties, PROP_RUN_FORMATS) ?? '').split(',');
  const starts = [0, ...boundaries];
  const runs: RunFormatting[] = [];
  let link: string | undefined;
  starts.forEach((start, i) => {
    const end = boundaries[i] ?? text.length;
    const target = lookup(byId, refs[i]);
    if (target?.classId === WORD_CLASS_FIELD_CHARACTER) {
      const code = readProp(target.properties, PROP_FIELD_CODE);
      if (code !== undefined) link = linkTarget(code) ?? link;
      if (readProp(target.properties, PROP_FIELD_CHARACTER_KIND) === FIELD_END) link = undefined;
      return;
    }
    const runText = text.slice(start, end).split(FIELD_PLACEHOLDER).join('');
    if (runText.length === 0) return;
    const settings = target?.classId === WORD_CLASS_CHAR_FORMAT ? characterSettings(byId, target) : {};
    const run = compact<RunFormatting>({ text: runText, ...settings, link });
    const previous = runs[runs.length - 1];
    if (previous && sameFormatting(previous, run)) previous.text += run.text;
    else runs.push(run);
  });
  return runs;
};

/** A paragraph flag the paragraph sets, as a boolean; absent when it sets none. */
const flag = (properties: (string | number)[], id: number): boolean | undefined => {
  const value = readProp(properties, id);
  return value === undefined ? undefined : value === 'true';
};

const points = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value) / TWIPS_PER_POINT;

const alignmentName = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const named = Object.entries(ALIGNMENTS).find(([, code]) => code === value);
  return named ? named[0] : `code ${value}`;
};

export interface WordReadFormattingArgs {
  /** First paragraph to report (1-based). */
  from: number;
  /** Last paragraph to report, inclusive. */
  to?: number;
}

const positiveInteger = (raw: Record<string, unknown>, key: string): number | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new FrameBridgeValidationError(`word_read_formatting \`${key}\` must be a positive integer.`);
  }
  return value;
};

/** The `word_read_formatting` action: each paragraph's style, paragraph formatting and formatted runs. */
export const wordReadFormattingAction: PodsReadActionSpec<WordReadFormattingArgs> = {
  kind: 'read',
  classFilter: [...WORD_STRUCTURE_CLASSES, WORD_CLASS_STYLE, WORD_CLASS_CHAR_FORMAT, WORD_CLASS_FIELD_CHARACTER],
  parseArgs: raw => {
    const from = positiveInteger(raw, 'from') ?? 1;
    const to = positiveInteger(raw, 'to');
    if (to !== undefined && to < from) {
      throw new FrameBridgeValidationError('word_read_formatting `to` must not be before `from`.');
    }
    return { from, to };
  },
  read: (model, args) => {
    const byId = byIdIndex(model);
    const all = listWordParagraphs(model);
    const last = Math.min(args.to ?? all.length, all.length, args.from + MAX_PARAGRAPHS - 1);
    const paragraphs: ParagraphFormatting[] = all.slice(args.from - 1, last).map(p => {
      const props = p.paragraph.properties;
      const style = lookup(byId, readProp(props, PROP_PARAGRAPH_STYLE));
      const shading = readProp(props, PROP_SHADING);
      const lineSpacing = readProp(props, PROP_LINE_SPACING);
      const listed = readProp(props, PROP_LIST_ID) !== undefined;
      return compact<ParagraphFormatting>({
        index: p.index,
        text: p.text.split(FIELD_PLACEHOLDER).join(''),
        style: style ? (readProp(style.properties, PROP_STYLE_NAME) ?? null) : null,
        alignment: alignmentName(readProp(props, PROP_ALIGNMENT[0] as number)),
        indentLeft: points(readProp(props, PROP_INDENT_LEFT)),
        spaceBefore: points(readProp(props, PROP_SPACE_BEFORE)),
        spaceAfter: points(readProp(props, PROP_SPACE_AFTER)),
        lineSpacing: lineSpacing === undefined ? undefined : Number(lineSpacing) / 240,
        shading: shading === undefined ? undefined : hexColor(shading),
        listLevel: listed ? Number(readProp(props, PROP_LIST_LEVEL) ?? 0) : undefined,
        keepWithNext: flag(props, PROP_KEEP_WITH_NEXT),
        keepLinesTogether: flag(props, PROP_KEEP_LINES_TOGETHER),
        pageBreakBefore: flag(props, PROP_PAGE_BREAK_BEFORE),
        runs: paragraphRuns(byId, p.paragraph),
      });
    });
    return {
      paragraphs,
      totalParagraphs: all.length,
      truncated: last < Math.min(args.to ?? all.length, all.length),
    };
  },
};
