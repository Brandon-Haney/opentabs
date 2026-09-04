/**
 * Pods `add_paragraph` action — append a paragraph to a shape in an OPEN deck, live.
 *
 * This is the editor's `NewLine` (pressing Enter), and its shape is surprising: a
 * split does NOT append a paragraph to the text body that already holds one. It
 * appends a whole new TEXT BODY block to the shape, and that block holds the new
 * paragraph. A shape's content-reference list (`603986976`) is therefore a list of
 * blocks, not a single one — which is why every read path walks shape → text body
 * → paragraph rather than assuming one body per shape.
 *
 * The write is one POST carrying CHAINED revisions: each revision's `BaseId` is the
 * previous revision's `Id`, so the server applies them in order against a base that
 * only exists inside this request. The engine's identity substitution is a plain
 * string replace over the serialized body, so the chain is expressed with literal
 * `{guidToken}|n` slots and needs no special support below this layer.
 *
 * ## Provenance, because the two halves are not equally proven
 *
 * Revisions 1 and 2 are transcribed from a captured `NewLine` — an Enter pressed at
 * the end of a title — and reproduce it object for object. Revision 3 types the
 * caller's text into the paragraph the first two created. It was NOT captured: it
 * is the object shape of the verified `set_text` write, aimed at a paragraph minted
 * in the same POST, chained by the mechanism revisions 1 and 2 demonstrate. Both
 * halves are individually proven and the composition is not, so this action needs a
 * live round-trip before it is trusted; `dry_run` returns the constructed body.
 *
 * An empty paragraph the caller cannot then address is not a usable feature — the
 * new paragraph's object id contains the write GUID, which is substituted below
 * this layer and never surfaces in a result — so the text is not optional.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { typingParagraphAndRun } from './pods-action-set-text.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  actionDescIdOf,
  CLASS_PARAGRAPH,
  CLASS_RENDER_SHAPE,
  CLASS_RUN,
  CLASS_TEXT_BODY,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  type PodsObject,
  PROP_CONTENT_REFS,
  PROP_ORDERED_CHILDREN,
  PROP_RUN_REF,
  PROP_SHAPE_NAME,
  PROP_TEXT,
  parseRefList,
  readProp,
  refToObjectId,
} from './pods-model.js';

/**
 * Property ids this build writes. Names come from the editor's own property
 * catalog where it carries one; the rest are described by what the capture shows
 * them doing, rather than given an invented name.
 */
/** `endOfParagraphFormatting` — the run supplying the formatting a caret at the paragraph's end inherits. */
const PROP_END_OF_PARAGRAPH_FORMATTING = 536886591;
/** A guid shared by a text body and every paragraph inside it: the block a paragraph belongs to. */
const PROP_BLOCK_OWNER = 469780482;
/** Per-line character counts, as `{"Lines":[n]}`. The server recomputes it; the editor still sends it. */
const PROP_LINE_LENGTHS = 469780757;
/** Set to `"1"` on every text body the editor creates. */
const PROP_TEXT_BODY_MARKER = 201333763;
/** Creation time of a new block, in epoch milliseconds. */
const PROP_CREATED_TIME = 335551753;
/** `lastModifiedTime`, in epoch milliseconds. */
const PROP_LAST_MODIFIED_TIME = 335551866;
/**
 * Present on a paragraph the editor creates and absent from the one it split off.
 * `WordPersistedProperties` index 52, between `listLevel` and the indent values,
 * and always `"0"` in the capture.
 */
const PROP_NEW_PARAGRAPH_INDENT = 335559732;

/** Properties a new text body copies verbatim from a paragraph already in the shape. */
const TEXT_BODY_INHERITED = [
  335559683, // listLevel
  335562753, // shapeId
  335562805, // sid — creation id
  335562806, // cid — creation id
  469780968, // slideType
] as const;

/** Object slots minted under the write GUID. Distinct so nothing in the chain collides. */
const SLOT_NEW_PARAGRAPH = 1;
const SLOT_SPLIT_REVISION = 2;
const SLOT_SPLIT_GROUP = 3;
const SLOT_LINES_REVISION = 4;
const SLOT_LINES_GROUP = 5;
const SLOT_NEW_TEXT_BODY = 6;
const SLOT_TYPING_REVISION = 7;
const SLOT_TYPING_GROUP = 8;
const SLOT_TYPING_RUN = 9;

/** The client sequence hint the captured NewLine carried. Not server-validated. */
const REVISION_SEQUENCE = 11;

/** The validated arguments of an `add_paragraph` action. */
export interface AddParagraphArgs {
  /** Exact visible text of the paragraph the new one is appended after. */
  after: string;
  /** The text the new paragraph carries. */
  text: string;
}

/** The live objects an `add_paragraph` write needs, resolved from the model. */
export interface AddParagraphContext {
  /** The storage cell the target's slide lives in. */
  cellId: string;
  /** The action-descriptor object id. */
  actionDescId: string;
  /** The paragraph the new one follows; resubmitted unchanged so the split is anchored. */
  sourceParagraphId: string;
  sourceProperties: (string | number)[];
  /** The run the source paragraph references — the new paragraph inherits it. */
  sourceRun: PodsObject;
  /** The source paragraph's raw run-reference value. */
  sourceRunRef: string;
  /**
   * The formatting a caret at the END of the source paragraph inherits, which the
   * new paragraph takes over.
   *
   * The captured split could not distinguish this from the source's run reference:
   * that paragraph carried no end-mark of its own, so the two coincided. Live
   * paragraphs do carry one, and it is frequently a DIFFERENT run from the body
   * text's — so an end-mark is inherited as an end-mark, and the run reference is
   * only the fallback for a source that has none, which is exactly the captured
   * case. Getting this wrong is cosmetic (the new line inherits the wrong
   * formatting) rather than destructive.
   */
  sourceEndMarkRef: string;
  /** The shape whose block list gains an entry. */
  shapeObjectId: string;
  shapeProperties: (string | number)[];
  /** The shape's current block list (`603986976`). */
  contentRefs: string;
  /** The block references parsed from that list. */
  contentRefTokens: string[];
  /** The shape's name, for the result. */
  shapeName: string | null;
}

/**
 * Find the paragraph to append after, and the shape and run the new paragraph needs.
 *
 * Walks up rather than down: the paragraph is matched by its exact visible text,
 * then the text body claiming it as a child is found, then the shape claiming that
 * body. Errors name nearby text so a near-miss is a one-step fix.
 */
export const resolveAddParagraphContext = (model: PodsModel, after: string): AddParagraphContext => {
  const root = findPresentationRoot(model);
  const byId = new Map(model.objects.map(o => [o.objectId, o]));

  const paragraph = model.objects.find(
    o => o.classId === CLASS_PARAGRAPH && readProp(o.properties, PROP_TEXT) === after,
  );
  if (!paragraph) {
    const samples = model.objects
      .filter(o => o.classId === CLASS_PARAGRAPH)
      .map(o => readProp(o.properties, PROP_TEXT))
      .filter((t): t is string => Boolean(t))
      .slice(0, 12);
    throw new FrameBridgeValidationError(
      `No text on the slide exactly matches "${after}". Nearby text: ${samples.map(t => `"${t}"`).join(', ')}`,
    );
  }

  const textBody = model.objects.find(
    o =>
      o.classId === CLASS_TEXT_BODY &&
      parseRefList(readProp(o.properties, PROP_ORDERED_CHILDREN) ?? '').some(
        token => refToObjectId(token) === paragraph.objectId,
      ),
  );
  if (!textBody) {
    throw new FrameBridgeValidationError(
      `Paragraph "${after}" is in the live model but no text body (393229) lists it as a child, so the shape ` +
        'holding it cannot be identified. Re-read the deck and retry.',
    );
  }

  const shape = model.objects.find(
    o =>
      o.classId === CLASS_RENDER_SHAPE &&
      parseRefList(readProp(o.properties, PROP_CONTENT_REFS) ?? '').some(
        token => refToObjectId(token) === textBody.objectId,
      ),
  );
  if (!shape) {
    throw new FrameBridgeValidationError(
      `No shape (1074135132) claims the text body holding "${after}", so there is no block list to append to.`,
    );
  }

  const sourceRunRef = readProp(paragraph.properties, PROP_RUN_REF) ?? '';
  const sourceEndMarkRef = readProp(paragraph.properties, PROP_END_OF_PARAGRAPH_FORMATTING) ?? sourceRunRef;
  const firstRunToken = parseRefList(sourceRunRef)[0];
  const runId = firstRunToken ? refToObjectId(firstRunToken) : null;
  const sourceRun = runId ? byId.get(runId) : undefined;
  if (!sourceRun || sourceRun.classId !== CLASS_RUN) {
    throw new FrameBridgeValidationError(
      `Paragraph "${after}" references no formatting run, so a new paragraph has nothing to inherit its ` +
        'formatting from. Add the paragraph after one that carries text.',
    );
  }

  return {
    cellId: paragraph.cellId ?? cellIdOf(root),
    actionDescId: actionDescIdOf(root),
    sourceParagraphId: paragraph.objectId,
    sourceProperties: paragraph.properties,
    sourceRun,
    sourceRunRef,
    sourceEndMarkRef,
    shapeObjectId: shape.objectId,
    shapeProperties: shape.properties,
    contentRefs: readProp(shape.properties, PROP_CONTENT_REFS) ?? '',
    contentRefTokens: parseRefList(readProp(shape.properties, PROP_CONTENT_REFS) ?? ''),
    shapeName: readProp(shape.properties, PROP_SHAPE_NAME) ?? null,
  };
};

/** Copy a flat property list, replacing the values named in `overrides`. */
const copyWith = (
  properties: (string | number)[],
  overrides: Map<number, string>,
  extras: Array<[number, string]>,
): (string | number)[] => {
  const copied: (string | number)[] = [];
  const applied = new Set<number>();
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key === undefined || value === undefined) continue;
    const override = typeof key === 'number' ? overrides.get(key) : undefined;
    if (override !== undefined) applied.add(key as number);
    copied.push(key, override ?? value);
  }
  for (const [key, value] of overrides) if (!applied.has(key)) copied.push(key, value);
  for (const [key, value] of extras) copied.push(key, value);
  return sortPropertiesById(copied);
};

/**
 * Build the chained `NewLine` body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The shape and the source paragraph are
 * verbatim copies — the shape's block list is the single value that changes — so a
 * split cannot disturb the text already on the slide.
 */
export const buildAddParagraphBody = (
  ctx: AddParagraphContext,
  text: string,
  guidToken: string,
  headToken: string,
  blockOwnerGuid: string,
  actionDescriptorJson: string,
  createdTime: string,
): Record<string, unknown> => {
  const newParagraphId = `${guidToken}|${SLOT_NEW_PARAGRAPH}`;
  const newTextBodyRef = `{${guidToken}}{${SLOT_NEW_TEXT_BODY}}`;

  // The shape, verbatim except for one appended block reference.
  const newContentRefs = ctx.contentRefs.length > 0 ? `${ctx.contentRefs},${newTextBodyRef}` : newTextBodyRef;
  const shapeProperties = copyWith(ctx.shapeProperties, new Map([[PROP_CONTENT_REFS, newContentRefs]]), []);

  // The new text body: the block that will hold the new paragraph. Its shared
  // identity properties come from the paragraph already in the shape, so the new
  // block belongs to the same slide and shape as its neighbour.
  const textBodyProperties: (string | number)[] = [
    PROP_TEXT_BODY_MARKER,
    '1',
    PROP_CREATED_TIME,
    createdTime,
    PROP_LAST_MODIFIED_TIME,
    createdTime,
    PROP_BLOCK_OWNER,
    blockOwnerGuid,
    PROP_ORDERED_CHILDREN,
    `{${guidToken}}{${SLOT_NEW_PARAGRAPH}}`,
  ];
  for (const id of TEXT_BODY_INHERITED) {
    const value = readProp(ctx.sourceProperties, id);
    if (value !== undefined) textBodyProperties.push(id, value);
  }

  // The new paragraph: a clone of the source's formatting with no text of its own,
  // owned by the new block, and pointing at the source's run for both its text
  // formatting and its end-of-paragraph formatting.
  const splitParagraphProperties = copyWith(
    ctx.sourceProperties,
    new Map([
      [PROP_TEXT, ''],
      [PROP_BLOCK_OWNER, blockOwnerGuid],
      [PROP_END_OF_PARAGRAPH_FORMATTING, ctx.sourceEndMarkRef],
      [PROP_NEW_PARAGRAPH_INDENT, '0'],
    ]),
    [],
  );

  const revision = (
    slot: number,
    groupSlot: number,
    baseId: string,
    objects: Array<Record<string, unknown>>,
  ): Record<string, unknown> => ({
    Id: `${guidToken}|${slot}`,
    FileId: null,
    RelativePath: null,
    CellId: ctx.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: baseId,
    RootObjectDescriptors: null,
    ObjectGroups: [{ Id: `${guidToken}|${groupSlot}`, Objects: objects }],
    IsFolderCell: false,
  });

  // Revision 1 — the split itself. Only this revision carries an action
  // descriptor: the captured chain leaves the follow-up revisions without one,
  // and the server applies the object diff either way.
  const split = revision(SLOT_SPLIT_REVISION, SLOT_SPLIT_GROUP, headToken, [
    {
      ObjectId: ctx.actionDescId,
      ClassId: 131140,
      Properties: [134236193, 'true', 335562934, '1', 469780658, actionDescriptorJson, 469780989, 'NewLine'],
    },
    { ObjectId: ctx.shapeObjectId, ClassId: CLASS_RENDER_SHAPE, Properties: shapeProperties },
    { ObjectId: ctx.sourceParagraphId, ClassId: CLASS_PARAGRAPH, Properties: sortPropertiesById(ctx.sourceProperties) },
    {
      ObjectId: `${guidToken}|${SLOT_NEW_TEXT_BODY}`,
      ClassId: CLASS_TEXT_BODY,
      Properties: sortPropertiesById(textBodyProperties),
    },
    { ObjectId: newParagraphId, ClassId: CLASS_PARAGRAPH, Properties: splitParagraphProperties },
  ]);

  // Revision 2 — correct the inherited line lengths for a paragraph that is now
  // empty. The clone carried the source's, which describe the source's text.
  const emptyLineParagraph = copyWith(splitParagraphProperties, new Map([[PROP_LINE_LENGTHS, '{"Lines":[1]}']]), []);
  const relines = revision(SLOT_LINES_REVISION, SLOT_LINES_GROUP, `${guidToken}|${SLOT_SPLIT_REVISION}`, [
    { ObjectId: newParagraphId, ClassId: CLASS_PARAGRAPH, Properties: emptyLineParagraph },
  ]);

  // Revision 3 — type the caller's text into the paragraph the first two created.
  const typed = typingParagraphAndRun(emptyLineParagraph, ctx.sourceRun, text, `{${guidToken}}{${SLOT_TYPING_RUN}}`);
  const typing = revision(SLOT_TYPING_REVISION, SLOT_TYPING_GROUP, `${guidToken}|${SLOT_LINES_REVISION}`, [
    { ObjectId: newParagraphId, ClassId: CLASS_PARAGRAPH, Properties: typed.paragraphProperties },
    ...(typed.runProperties
      ? [{ ObjectId: `${guidToken}|${SLOT_TYPING_RUN}`, ClassId: CLASS_RUN, Properties: typed.runProperties }]
      : []),
  ]);

  return {
    Mode: 4,
    srs: [
      [
        3,
        {
          OperationId: 1,
          DependentOn: 0,
          Revisions: [split, relines, typing],
          ExpectedLatestId: headToken,
          Sequence: REVISION_SEQUENCE,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

/** The `add_paragraph` action: append a paragraph carrying text to the shape holding `after`. */
export const addParagraphAction: PodsWriteActionSpec<AddParagraphArgs, AddParagraphContext> = {
  kind: 'write',
  classFilter: [CLASS_RENDER_SHAPE, CLASS_TEXT_BODY, CLASS_PARAGRAPH, CLASS_RUN],
  parseArgs: raw => {
    if (typeof raw.after !== 'string' || raw.after.length === 0) {
      throw new FrameBridgeValidationError(
        'add_paragraph needs `after`: the exact visible text of the paragraph to append after.',
      );
    }
    if (typeof raw.text !== 'string' || raw.text.length === 0) {
      throw new FrameBridgeValidationError('add_paragraph needs `text`: the text the new paragraph carries.');
    }
    if (raw.text.includes('\n')) {
      throw new FrameBridgeValidationError(
        'add_paragraph adds one paragraph and cannot carry line breaks — call it once per paragraph.',
      );
    }
    return { after: raw.after, text: raw.text };
  },
  resolve: (model, args) => resolveAddParagraphContext(model, args.after),
  build: (ctx, args, mint: PodsMint) =>
    buildAddParagraphBody(
      ctx,
      args.text,
      mint.guidToken,
      mint.headToken,
      // The block owner is a plain guid; the mint's seed is a fresh one per call, so
      // a conflict retry re-sends the same block rather than inventing another.
      mint.seed,
      JSON.stringify({ ActionId: mint.seed, ActionName: 'Enter', ActionTime: mint.actionTime }),
      mint.actionTime,
    ),
  /**
   * Applied when the shape carries a block the first resolve did not know AND the
   * paragraph inside it carries the requested text.
   *
   * The block alone is not enough. The three revisions are chained but the server
   * accepts them individually, so confirming on the block would report success for
   * a write whose typing revision was accepted and silently dropped — leaving an
   * empty line and a caller told it landed. Following the new block through to its
   * paragraph's text confirms what was actually asked for, and cannot be satisfied
   * by a co-author splitting a paragraph in this shape at the same moment.
   */
  isApplied: (model, first, args) => {
    const shape = model.objects.find(o => o.objectId === first.shapeObjectId);
    if (!shape) return false;
    const known = new Set(first.contentRefTokens);
    const added = parseRefList(readProp(shape.properties, PROP_CONTENT_REFS) ?? '').filter(ref => !known.has(ref));
    return added.some(ref => {
      const bodyId = refToObjectId(ref);
      const body = bodyId ? model.objects.find(o => o.objectId === bodyId && o.classId === CLASS_TEXT_BODY) : undefined;
      if (!body) return false;
      return parseRefList(readProp(body.properties, PROP_ORDERED_CHILDREN) ?? '').some(childRef => {
        const childId = refToObjectId(childRef);
        const child = childId ? model.objects.find(o => o.objectId === childId) : undefined;
        return child !== undefined && readProp(child.properties, PROP_TEXT) === args.text;
      });
    });
  },
  // An append is not idempotent — retrying one that already applied adds a SECOND paragraph.
  idempotent: false,
  summarize: (ctx, args) => ({
    after: args.after,
    text: args.text,
    shape: ctx.shapeName,
    sourceParagraphId: ctx.sourceParagraphId,
    blocksBefore: ctx.contentRefTokens.length,
  }),
  dryRunExtras: (ctx, args) => ({
    after: args.after,
    text: args.text,
    shape: ctx.shapeName,
    sourceParagraphId: ctx.sourceParagraphId,
  }),
};
