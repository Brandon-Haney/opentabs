/**
 * Word live co-authoring actions: read the document, replace text, insert
 * paragraphs, delete a paragraph — all against an OPEN document, through the
 * pods engine (see `word-live-model.ts` for the object graph and envelope).
 *
 * Each write was decoded from the editor's own write for the same gesture and
 * reduced to the objects that carry the change; the editor's undo-history and
 * author records ride alongside its writes but are not needed for one to apply,
 * render live in every open editor, and persist (verified live 2026-10-01).
 *
 * - Typing resubmits the paragraph with its whole new text.
 * - Enter adds a block to the container's block list, holding a new paragraph.
 * - Removing a block from that list removes its paragraph.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsReadActionSpec, PodsWriteActionSpec } from './pods-actions.js';
import {
  type PodsModel,
  type PodsObject,
  PROP_CONTENT_REFS,
  PROP_ORDERED_CHILDREN,
  parseRefList,
  readProp,
  refToObjectId,
} from './pods-model.js';
import {
  buildWordRevisionBody,
  findContainerOf,
  findUniqueParagraph,
  listWordParagraphs,
  PROP_BLOCK_CREATED,
  PROP_LIST_ID,
  PROP_LIST_LEVEL,
  PROP_PARAGRAPH_STYLE,
  PROP_STYLE_NAME,
  paragraphAtIndex,
  WORD_CLASS_BLOCK,
  WORD_CLASS_PARAGRAPH,
  WORD_CLASS_STYLE,
  WORD_STRUCTURE_CLASSES,
  type WordParagraph,
  type WordWriteObject,
  withBlockList,
  wordCellIdOf,
  wordParagraphText,
} from './word-live-model.js';
import { findOccurrences, newParagraphProperties, paragraphIdFrom, replaceInParagraph } from './word-paragraph-runs.js';

/** Paragraphs a live read returns before capping. */
const MAX_READ_PARAGRAPHS = 2000;
/** Paragraphs one insert may add. */
const MAX_INSERTED_PARAGRAPHS = 50;

const requireString = (raw: Record<string, unknown>, key: string, action: string, what: string): string => {
  const value = raw[key];
  if (typeof value !== 'string') throw new FrameBridgeValidationError(`${action} needs \`${key}\`: ${what}.`);
  return value;
};

const rejectLineBreaks = (text: string, action: string): void => {
  if (/[\r\n]/.test(text)) {
    throw new FrameBridgeValidationError(
      `${action} text cannot contain line breaks — a paragraph is one line of text. ` +
        'Insert several paragraphs to write several lines.',
    );
  }
};

/** A positive integer index, or undefined when absent. */
const optionalIndex = (raw: Record<string, unknown>, action: string): number | undefined => {
  if (raw.index === undefined) return undefined;
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 1) {
    throw new FrameBridgeValidationError(`${action} \`index\` must be a positive integer.`);
  }
  return raw.index;
};

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** One paragraph as the live read reports it. */
interface LiveParagraph {
  index: number;
  text: string;
  style: string | null;
  /** List nesting level (0 = top) when the paragraph is a list item. */
  listLevel: number | null;
  inTable: boolean;
}

const styleNameOf = (model: PodsModel, paragraph: PodsObject): string | null => {
  const ref = readProp(paragraph.properties, PROP_PARAGRAPH_STYLE);
  const id = ref ? refToObjectId(ref) : null;
  const style = id ? model.objects.find(o => o.objectId === id) : undefined;
  return style ? (readProp(style.properties, PROP_STYLE_NAME) ?? null) : null;
};

/** The `word_read` action: the document's paragraphs as they are in the editor right now. */
export const wordReadAction: PodsReadActionSpec<Record<string, never>> = {
  kind: 'read',
  classFilter: [...WORD_STRUCTURE_CLASSES, WORD_CLASS_STYLE],
  parseArgs: () => ({}),
  read: model => {
    const paragraphs = listWordParagraphs(model);
    const reported: LiveParagraph[] = paragraphs.slice(0, MAX_READ_PARAGRAPHS).map(p => {
      const listed = readProp(p.paragraph.properties, PROP_LIST_ID) !== undefined;
      const level = readProp(p.paragraph.properties, PROP_LIST_LEVEL);
      return {
        index: p.index,
        text: p.text,
        style: styleNameOf(model, p.paragraph),
        listLevel: listed ? Number(level ?? 0) : null,
        inTable: p.inTable,
      };
    });
    return { paragraphs: reported, totalParagraphs: paragraphs.length, truncated: paragraphs.length > reported.length };
  },
};

// ---------------------------------------------------------------------------
// replace text
// ---------------------------------------------------------------------------

export interface WordReplaceTextArgs {
  find: string;
  replace: string;
  /** Replace every occurrence; otherwise `find` must occur exactly once. */
  all: boolean;
}

interface ReplaceTarget {
  paragraphId: string;
  cellId: string;
  index: number;
  newText: string;
  properties: (string | number)[];
  count: number;
}

export interface WordReplaceTextContext {
  targets: ReplaceTarget[];
}

export const resolveWordReplaceText = (model: PodsModel, args: WordReplaceTextArgs): WordReplaceTextContext => {
  const targets: ReplaceTarget[] = [];
  for (const p of listWordParagraphs(model)) {
    if (findOccurrences(p.text, args.find).length === 0) continue;
    const replaced = replaceInParagraph(p.paragraph.properties, args.find, args.replace);
    targets.push({
      paragraphId: p.paragraph.objectId,
      cellId: wordCellIdOf(model, p.paragraph),
      index: p.index,
      newText: replaced.text,
      properties: replaced.properties,
      count: replaced.count,
    });
  }
  const total = targets.reduce((sum, t) => sum + t.count, 0);
  if (total === 0) {
    throw new FrameBridgeValidationError(
      `"${args.find}" does not occur in the document. Text is matched within one paragraph, exactly as written ` +
        '(case-sensitive); read the live document to copy it verbatim.',
    );
  }
  if (!args.all && total > 1) {
    throw new FrameBridgeValidationError(
      `"${args.find}" occurs ${total} times (paragraphs ${targets.map(t => `#${t.index}`).join(', ')}). ` +
        'Pass more surrounding text to pick one occurrence, or all: true to replace every one.',
    );
  }
  const cells = new Set(targets.map(t => t.cellId));
  if (cells.size > 1) {
    throw new FrameBridgeValidationError(
      'The matches lie in more than one storage cell of the document; replace them one paragraph at a time.',
    );
  }
  return { targets };
};

/** The `word_replace_text` action: replace text inside paragraphs, keeping their formatting. */
export const wordReplaceTextAction: PodsWriteActionSpec<WordReplaceTextArgs, WordReplaceTextContext> = {
  kind: 'write',
  classFilter: WORD_STRUCTURE_CLASSES,
  parseArgs: raw => {
    const find = requireString(raw, 'find', 'word_replace_text', 'the exact text to replace');
    const replace = requireString(raw, 'replace', 'word_replace_text', 'the replacement text');
    if (find.length === 0) throw new FrameBridgeValidationError('word_replace_text `find` must not be empty.');
    if (find === replace) throw new FrameBridgeValidationError('word_replace_text `replace` is identical to `find`.');
    rejectLineBreaks(replace, 'word_replace_text');
    if (raw.all !== undefined && typeof raw.all !== 'boolean') {
      throw new FrameBridgeValidationError('word_replace_text `all` must be a boolean.');
    }
    return { find, replace, all: raw.all === true };
  },
  resolve: resolveWordReplaceText,
  build: (ctx, _args, mint: PodsMint) =>
    buildWordRevisionBody(
      ctx.targets.map(t => ({ ObjectId: t.paragraphId, ClassId: WORD_CLASS_PARAGRAPH, Properties: t.properties })),
      (ctx.targets[0] as ReplaceTarget).cellId,
      mint.guidToken,
      mint.headToken,
    ),
  // Applied when every target paragraph — found by its id, not by text — now reads as intended.
  isApplied: (model, first) => first.targets.every(t => wordParagraphText(model, t.paragraphId) === t.newText),
  // After it applies the old text is gone, so a blind re-issue would fail to resolve.
  idempotent: false,
  summarize: (ctx, args) => ({
    find: args.find,
    replace: args.replace,
    replacements: ctx.targets.reduce((sum, t) => sum + t.count, 0),
    paragraphs: ctx.targets.map(t => ({ index: t.index, text: t.newText })),
  }),
  dryRunExtras: ctx => ({ paragraphs: ctx.targets.map(t => ({ index: t.index, text: t.newText })) }),
};

// ---------------------------------------------------------------------------
// insert paragraphs
// ---------------------------------------------------------------------------

export interface WordInsertParagraphsArgs {
  /** Text identifying the anchor paragraph (exact, or a unique substring). */
  anchor?: string;
  /** The anchor's 1-based reading-order index, as the live read reports it. */
  index?: number;
  position: 'before' | 'after';
  paragraphs: string[];
}

export interface WordInsertParagraphsContext {
  anchor: WordParagraph;
  cellId: string;
}

const resolveAnchor = (model: PodsModel, args: { anchor?: string; index?: number }, role: string): WordParagraph => {
  const paragraphs = listWordParagraphs(model);
  return args.index !== undefined
    ? paragraphAtIndex(paragraphs, args.index)
    : findUniqueParagraph(paragraphs, args.anchor as string, role);
};

/** Re-find a paragraph by its block, the identity that survives edits to its text and position. */
const rebindByBlock = (model: PodsModel, blockRef: string): WordParagraph => {
  const found = listWordParagraphs(model).find(p => p.blockRef === blockRef);
  if (!found) throw new FrameBridgeValidationError('The target paragraph was removed from the document meanwhile.');
  return found;
};

const parseAnchorArgs = (raw: Record<string, unknown>, action: string): { anchor?: string; index?: number } => {
  const index = optionalIndex(raw, action);
  if (index !== undefined) return { index };
  if (typeof raw.anchor !== 'string' || raw.anchor.length === 0) {
    throw new FrameBridgeValidationError(`${action} needs \`anchor\` (paragraph text) or \`index\`.`);
  }
  return { anchor: raw.anchor };
};

const insertedBlockSlot = (i: number): number => 3 + 2 * i;
const insertedParagraphSlot = (i: number): number => 4 + 2 * i;

export const buildWordInsertParagraphsBody = (
  ctx: WordInsertParagraphsContext,
  args: WordInsertParagraphsArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  const { guidToken, seed } = mint;
  const created: WordWriteObject[] = [];
  const newRefs: string[] = [];
  args.paragraphs.forEach((text, i) => {
    const blockSlot = insertedBlockSlot(i);
    const paragraphSlot = insertedParagraphSlot(i);
    newRefs.push(`{${guidToken}}{${blockSlot}}`);
    created.push(
      {
        ObjectId: `${guidToken}|${blockSlot}`,
        ClassId: WORD_CLASS_BLOCK,
        Properties: [PROP_BLOCK_CREATED, '1', PROP_ORDERED_CHILDREN, `{${guidToken}}{${paragraphSlot}}`],
      },
      {
        ObjectId: `${guidToken}|${paragraphSlot}`,
        ClassId: WORD_CLASS_PARAGRAPH,
        Properties: newParagraphProperties(
          ctx.anchor.paragraph.properties,
          text,
          paragraphIdFrom(seed, paragraphSlot),
          paragraphIdFrom(seed, -paragraphSlot),
        ),
      },
    );
  });

  const refs = parseRefList(readProp(ctx.anchor.container.properties, PROP_CONTENT_REFS) ?? '');
  const at = refs.indexOf(ctx.anchor.blockRef) + (args.position === 'after' ? 1 : 0);
  refs.splice(at, 0, ...newRefs);
  const container: WordWriteObject = {
    ObjectId: ctx.anchor.container.objectId,
    ClassId: ctx.anchor.container.classId,
    Properties: withBlockList(ctx.anchor.container, refs),
  };
  return buildWordRevisionBody([container, ...created], ctx.cellId, guidToken, mint.headToken);
};

/** The `word_insert_paragraphs` action: add paragraphs before or after an anchor paragraph. */
export const wordInsertParagraphsAction: PodsWriteActionSpec<WordInsertParagraphsArgs, WordInsertParagraphsContext> = {
  kind: 'write',
  classFilter: WORD_STRUCTURE_CLASSES,
  parseArgs: raw => {
    const anchor = parseAnchorArgs(raw, 'word_insert_paragraphs');
    const position = raw.position ?? 'after';
    if (position !== 'before' && position !== 'after') {
      throw new FrameBridgeValidationError('word_insert_paragraphs `position` must be "before" or "after".');
    }
    const paragraphs = raw.paragraphs;
    if (!Array.isArray(paragraphs) || paragraphs.length === 0 || !paragraphs.every(p => typeof p === 'string')) {
      throw new FrameBridgeValidationError('word_insert_paragraphs needs `paragraphs`: a non-empty list of strings.');
    }
    if (paragraphs.length > MAX_INSERTED_PARAGRAPHS) {
      throw new FrameBridgeValidationError(
        `word_insert_paragraphs adds at most ${MAX_INSERTED_PARAGRAPHS} paragraphs per call.`,
      );
    }
    for (const text of paragraphs as string[]) rejectLineBreaks(text, 'word_insert_paragraphs');
    return { ...anchor, position, paragraphs: paragraphs as string[] };
  },
  resolve: (model, args) => {
    const anchor = resolveAnchor(model, args, 'insert anchor');
    return { anchor, cellId: wordCellIdOf(model, anchor.container) };
  },
  rebind: (model, first) => {
    const anchor = rebindByBlock(model, first.anchor.blockRef);
    return { anchor, cellId: wordCellIdOf(model, anchor.container) };
  },
  build: buildWordInsertParagraphsBody,
  /**
   * Applied when the anchor's container lists blocks it did not list before, on
   * the requested side of the anchor, whose paragraphs read as requested in order
   * — matched by text, so a co-author's simultaneous insert cannot confirm this one.
   */
  isApplied: (model, first, args) => {
    const container = findContainerOf(model, first.anchor.blockRef);
    if (!container) return false;
    const before = new Set(parseRefList(readProp(first.anchor.container.properties, PROP_CONTENT_REFS) ?? ''));
    const refs = parseRefList(readProp(container.properties, PROP_CONTENT_REFS) ?? '');
    const anchorAt = refs.indexOf(first.anchor.blockRef);
    const side = args.position === 'after' ? refs.slice(anchorAt + 1) : refs.slice(0, anchorAt).reverse();
    const fresh: string[] = [];
    for (const ref of side) {
      if (before.has(ref)) break;
      fresh.push(ref);
    }
    const ordered = args.position === 'after' ? fresh : fresh.reverse();
    const texts = listWordParagraphs(model)
      .filter(p => ordered.includes(p.blockRef))
      .map(p => p.text);
    return texts.length === args.paragraphs.length && texts.every((text, i) => text === args.paragraphs[i]);
  },
  // Re-issuing an insert that already landed would add the paragraphs twice.
  idempotent: false,
  summarize: (ctx, args) => ({
    anchorIndex: ctx.anchor.index,
    anchorText: ctx.anchor.text,
    position: args.position,
    inserted: args.paragraphs.length,
  }),
  dryRunExtras: (ctx, args) => ({ anchorIndex: ctx.anchor.index, position: args.position }),
};

// ---------------------------------------------------------------------------
// delete paragraph
// ---------------------------------------------------------------------------

export interface WordDeleteParagraphArgs {
  anchor?: string;
  index?: number;
}

export interface WordDeleteParagraphContext {
  target: WordParagraph;
  cellId: string;
}

const deletionContext = (model: PodsModel, target: WordParagraph): WordDeleteParagraphContext => {
  const refs = parseRefList(readProp(target.container.properties, PROP_CONTENT_REFS) ?? '');
  if (refs.length <= 1) {
    throw new FrameBridgeValidationError(
      `Paragraph #${target.index} is the only one in its ${target.inTable ? 'table cell' : 'part of the document'}, ` +
        'which must keep one; replace its text instead.',
    );
  }
  return { target, cellId: wordCellIdOf(model, target.container) };
};

/** The `word_delete_paragraph` action: remove one paragraph, named by its text or index. */
export const wordDeleteParagraphAction: PodsWriteActionSpec<WordDeleteParagraphArgs, WordDeleteParagraphContext> = {
  kind: 'write',
  classFilter: WORD_STRUCTURE_CLASSES,
  parseArgs: raw => parseAnchorArgs(raw, 'word_delete_paragraph'),
  resolve: (model, args) => deletionContext(model, resolveAnchor(model, args, 'paragraph to delete')),
  rebind: (model, first) => deletionContext(model, rebindByBlock(model, first.target.blockRef)),
  build: (ctx, _args, mint) =>
    buildWordRevisionBody(
      [
        {
          ObjectId: ctx.target.container.objectId,
          ClassId: ctx.target.container.classId,
          Properties: withBlockList(
            ctx.target.container,
            parseRefList(readProp(ctx.target.container.properties, PROP_CONTENT_REFS) ?? '').filter(
              ref => ref !== ctx.target.blockRef,
            ),
          ),
        },
      ],
      ctx.cellId,
      mint.guidToken,
      mint.headToken,
    ),
  // Applied when no container lists the paragraph's block any more.
  isApplied: (model, first) => findContainerOf(model, first.target.blockRef) === undefined,
  // A re-issue rebinds by the block, which fails cleanly once it is gone — but an
  // unconfirmed delete is still reported rather than retried, like every structural write.
  idempotent: false,
  summarize: ctx => ({ deletedIndex: ctx.target.index, deletedText: ctx.target.text }),
  dryRunExtras: ctx => ({ deletedIndex: ctx.target.index, deletedText: ctx.target.text }),
};
