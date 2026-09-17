/**
 * Text blocks — the unit the editor creates whenever a paragraph is born.
 *
 * A shape's content-reference list (`603986976`) is a list of BLOCKS, and each
 * block is a text body (`393229`) holding paragraphs. The editor never grows a
 * block in place: pressing Enter appends a new block holding the new paragraph,
 * and typing over a whole multi-run paragraph swaps its block for a fresh one
 * holding a single-run paragraph with the new text. Both captures build the same
 * three objects, so both actions build them here:
 *
 * - the text body, owning the paragraph through `603986975`;
 * - the paragraph, a copy of its neighbour's properties with a single-run layout;
 * - a copy of the neighbour block's list-marker object (`393234`, referenced by
 *   `603986982`) when the neighbour has one — bulleted text carries it, a title
 *   does not.
 *
 * Decoded from the editor's `NewLine` and `PowerPointPasteGivenText` writes on
 * the test deck (2026-09-17); see `plugins/powerpoint/docs/pods-action-catalog.md`.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  CLASS_PARAGRAPH,
  CLASS_PLACEHOLDER_SHAPE,
  CLASS_RENDER_SHAPE,
  CLASS_RUN,
  CLASS_TEXT_BODY,
  isOnSlide,
  type PodsModel,
  type PodsObject,
  PROP_CONTENT_REFS,
  PROP_ORDERED_CHILDREN,
  PROP_RUN_REF,
  PROP_TEXT,
  parseRefList,
  readProp,
  refToObjectId,
} from './pods-model.js';
import { singleRunLayout } from './pods-text-runs.js';

/** A table: lists its rows in `603986976`. */
export const CLASS_TABLE = 393250;
/** A table row: lists its cells in `603986976`. */
export const CLASS_TABLE_ROW = 393251;
/** A table cell: like a shape, it lists the blocks it holds in `603986976`. */
export const CLASS_TABLE_CELL = 393252;
/** A block's list-marker object: the bullet character and its colour. */
export const CLASS_LIST_MARKER = 393234;
/** `endOfParagraphFormatting` — the run supplying the formatting a caret at the paragraph's end inherits. */
export const PROP_END_OF_PARAGRAPH_FORMATTING = 536886591;
/** A guid shared by a text body and every paragraph inside it: the block a paragraph belongs to. */
export const PROP_BLOCK_OWNER = 469780482;
/** Per-line character counts, as `{"Lines":[n]}`. The server recomputes it; the editor still sends it. */
export const PROP_LINE_LENGTHS = 469780757;
/** A text body's reference to its list-marker object. */
export const PROP_LIST_MARKER_REF = 603986982;
/** Set to `"1"` on every text body the editor creates. */
const PROP_TEXT_BODY_MARKER = 201333763;
/** Creation time of a new block, in epoch milliseconds. */
const PROP_CREATED_TIME = 335551753;
/** `lastModifiedTime`, in epoch milliseconds. */
export const PROP_LAST_MODIFIED_TIME = 335551866;

/** Properties a new text body copies verbatim from the paragraph it is modelled on. */
const TEXT_BODY_INHERITED = [
  335559683, // listLevel
  335562753, // shapeId
  335562805, // sid — creation id
  335562806, // cid — creation id
  469780968, // slideType
] as const;

/** ClassIds a model read must keep to resolve a paragraph's block. */
export const TEXT_BLOCK_CLASSES = [
  CLASS_RENDER_SHAPE,
  CLASS_PLACEHOLDER_SHAPE,
  CLASS_TABLE,
  CLASS_TABLE_ROW,
  CLASS_TABLE_CELL,
  CLASS_TEXT_BODY,
  CLASS_LIST_MARKER,
  CLASS_PARAGRAPH,
  CLASS_RUN,
];

/** A paragraph located in its block and the shape or table cell holding that block. */
export interface TextBlockLocation {
  paragraphId: string;
  paragraphProperties: (string | number)[];
  /** The storage cell the paragraph lives in, when the model reported one. */
  paragraphCellId: string | undefined;
  /** The run the paragraph's first segment references. */
  run: PodsObject;
  /** The formatting a caret at the paragraph's end inherits; the first run when it names none. */
  endMarkRef: string;
  textBodyId: string;
  /** The paragraph references the block holds, in order. */
  blockParagraphRefs: string[];
  /** The block's list-marker object, when it has one. */
  listMarker: PodsObject | undefined;
  /** The shape or table cell listing the block. */
  containerObjectId: string;
  containerClassId: number;
  containerProperties: (string | number)[];
  /** The container's block references (`603986976`), in order. */
  contentRefTokens: string[];
  /** The `{guid}{ctr}` reference naming the block in that list. */
  blockRef: string;
}

/**
 * Whether a table cell is still on its slide: listed by a row that its table lists.
 * A deleted row is only dropped from the table's row list, so its cells and their
 * text stay in the model after it is gone.
 */
const cellIsListed = (model: PodsModel, cellId: string): boolean => {
  const listing = (classId: number, childId: string) =>
    model.objects.find(
      o =>
        o.classId === classId &&
        parseRefList(readProp(o.properties, PROP_CONTENT_REFS) ?? '').some(token => refToObjectId(token) === childId),
    );
  const row = listing(CLASS_TABLE_ROW, cellId);
  return row !== undefined && listing(CLASS_TABLE, row.objectId) !== undefined;
};

/**
 * Resolve one paragraph object into its block and container, or explain why it has none.
 * Returns a string reason when the paragraph is not on a slide.
 */
const locateParagraph = (model: PodsModel, paragraph: PodsObject, text: string): TextBlockLocation | string => {
  const textBody = model.objects.find(
    o =>
      o.classId === CLASS_TEXT_BODY &&
      parseRefList(readProp(o.properties, PROP_ORDERED_CHILDREN) ?? '').some(
        token => refToObjectId(token) === paragraph.objectId,
      ),
  );
  if (!textBody) {
    return (
      `Paragraph "${text}" is in the live model but no text body (393229) lists it as a child, so the shape ` +
      'holding it cannot be identified. Re-read the deck and retry.'
    );
  }

  const container = model.objects.find(
    o =>
      (o.classId === CLASS_RENDER_SHAPE ||
        o.classId === CLASS_PLACEHOLDER_SHAPE ||
        (o.classId === CLASS_TABLE_CELL && cellIsListed(model, o.objectId))) &&
      parseRefList(readProp(o.properties, PROP_CONTENT_REFS) ?? '').some(
        token => refToObjectId(token) === textBody.objectId,
      ),
  );
  if (!container) {
    return `No shape, notes placeholder or table cell on a slide claims the text body holding "${text}", so it has no block list to change.`;
  }
  const contentRefTokens = parseRefList(readProp(container.properties, PROP_CONTENT_REFS) ?? '');
  const blockRef = contentRefTokens.find(token => refToObjectId(token) === textBody.objectId) as string;

  const firstRunToken = parseRefList(readProp(paragraph.properties, PROP_RUN_REF) ?? '')[0];
  const lookup = (id: string | null) => (id ? model.objects.find(o => o.objectId === id) : undefined);
  const run = lookup(firstRunToken ? refToObjectId(firstRunToken) : null);
  if (!firstRunToken || run?.classId !== CLASS_RUN) {
    return `Paragraph "${text}" references no formatting run, so there is nothing to inherit formatting from.`;
  }

  const marker = lookup(refToObjectId(readProp(textBody.properties, PROP_LIST_MARKER_REF) ?? ''));

  return {
    paragraphId: paragraph.objectId,
    paragraphProperties: paragraph.properties,
    paragraphCellId: paragraph.cellId,
    run,
    endMarkRef: readProp(paragraph.properties, PROP_END_OF_PARAGRAPH_FORMATTING) ?? firstRunToken,
    textBodyId: textBody.objectId,
    blockParagraphRefs: parseRefList(readProp(textBody.properties, PROP_ORDERED_CHILDREN) ?? ''),
    listMarker: marker?.classId === CLASS_LIST_MARKER ? marker : undefined,
    containerObjectId: container.objectId,
    containerClassId: container.classId,
    containerProperties: container.properties,
    contentRefTokens,
    blockRef,
  };
};

/**
 * Find the paragraph whose visible text is exactly `text` and that is still on a
 * slide, with the block and the shape or table cell holding it.
 *
 * Walks up rather than down: paragraph, then the text body claiming it, then the
 * container claiming that body. Every paragraph with the text is tried, because
 * the model keeps what edits retire — a replaced block's old paragraph, a deleted
 * row's cells — and those carry the same text as the live one. `slide` limits the
 * search to one slide, which a deck with a copied slide needs: the copy carries the
 * same text as its original. Errors name nearby text so a near-miss is a one-step fix.
 */
export const locateTextBlock = (model: PodsModel, text: string, slide?: PodsObject): TextBlockLocation => {
  const inScope = (o: PodsObject) => o.classId === CLASS_PARAGRAPH && (slide === undefined || isOnSlide(o, slide));
  const candidates = model.objects.filter(o => inScope(o) && readProp(o.properties, PROP_TEXT) === text);
  if (candidates.length === 0) {
    const samples = model.objects
      .filter(inScope)
      .map(o => readProp(o.properties, PROP_TEXT))
      .filter((t): t is string => Boolean(t))
      .slice(0, 12);
    throw new FrameBridgeValidationError(
      `No text on the slide exactly matches "${text}". Nearby text: ${samples.map(t => `"${t}"`).join(', ')}`,
    );
  }
  let firstReason = '';
  for (const paragraph of candidates) {
    const located = locateParagraph(model, paragraph, text);
    if (typeof located !== 'string') return located;
    firstReason ||= located;
  }
  throw new FrameBridgeValidationError(firstReason);
};

/** Copy a flat property list, replacing the values named in `overrides` and appending any it lacked. */
export const copyWith = (properties: (string | number)[], overrides: Map<number, string>): (string | number)[] => {
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
  return sortPropertiesById(copied);
};

/** The line-length value the editor sends for a single-line paragraph of `text`. */
export const singleLineLengths = (text: string): string => JSON.stringify({ Lines: [text.length + 1] });

/** What a new block copies from the paragraph it is modelled on. */
export type BlockSource = Pick<TextBlockLocation, 'paragraphProperties' | 'run' | 'endMarkRef' | 'listMarker'>;

/** Object slots and identity for one new block. */
export interface NewBlockIds {
  guidToken: string;
  textBodySlot: number;
  paragraphSlot: number;
  listMarkerSlot: number;
  /** The plain guid the text body, its paragraph and its list marker all carry as owner. */
  blockOwnerGuid: string;
  /** Epoch milliseconds, as a string. */
  createdTime: string;
}

/** The objects making up one new block, ready for an object group. */
export interface NewBlock {
  /** The `{guid}{ctr}` reference a shape lists the block by. */
  blockRef: string;
  paragraphId: string;
  paragraphProperties: (string | number)[];
  objects: Array<Record<string, unknown>>;
}

/**
 * Build a new block holding one paragraph with `text`, modelled on `source`.
 *
 * The paragraph copies the source's properties — indent, spacing, bullet level —
 * with the single-run layout every text change needs, so a source whose runs
 * split its OWN text cannot carry offsets past the end of the new text. The list
 * marker is copied, not shared, because the editor mints one per block.
 * `sharedOverrides` land on both the text body and the paragraph — the row and
 * column ids a table cell's block carries on each.
 */
export const buildNewBlock = (
  source: BlockSource,
  text: string,
  ids: NewBlockIds,
  paragraphOverrides: Map<number, string> = new Map(),
  sharedOverrides: Map<number, string> = new Map(),
): NewBlock => {
  const paragraphId = `${ids.guidToken}|${ids.paragraphSlot}`;
  const textBodyId = `${ids.guidToken}|${ids.textBodySlot}`;
  const listMarkerRef = `{${ids.guidToken}}{${ids.listMarkerSlot}}`;

  const textBodyProperties: (string | number)[] = [
    PROP_TEXT_BODY_MARKER,
    '1',
    PROP_CREATED_TIME,
    ids.createdTime,
    PROP_LAST_MODIFIED_TIME,
    ids.createdTime,
    PROP_BLOCK_OWNER,
    ids.blockOwnerGuid,
    PROP_ORDERED_CHILDREN,
    `{${ids.guidToken}}{${ids.paragraphSlot}}`,
  ];
  for (const id of TEXT_BODY_INHERITED) {
    const value = readProp(source.paragraphProperties, id);
    if (value !== undefined) textBodyProperties.push(id, value);
  }
  if (source.listMarker) textBodyProperties.push(PROP_LIST_MARKER_REF, listMarkerRef);
  for (const [id, value] of sharedOverrides) textBodyProperties.push(id, value);

  const paragraphProperties = copyWith(
    singleRunLayout(source.paragraphProperties),
    new Map([
      [PROP_TEXT, text],
      [PROP_BLOCK_OWNER, ids.blockOwnerGuid],
      [PROP_END_OF_PARAGRAPH_FORMATTING, source.endMarkRef],
      [PROP_LINE_LENGTHS, singleLineLengths(text)],
      ...sharedOverrides,
      ...paragraphOverrides,
    ]),
  );

  const objects: Array<Record<string, unknown>> = [
    { ObjectId: textBodyId, ClassId: CLASS_TEXT_BODY, Properties: sortPropertiesById(textBodyProperties) },
  ];
  if (source.listMarker) {
    objects.push({
      ObjectId: `${ids.guidToken}|${ids.listMarkerSlot}`,
      ClassId: CLASS_LIST_MARKER,
      Properties: copyWith(
        source.listMarker.properties,
        new Map([
          [PROP_BLOCK_OWNER, ids.blockOwnerGuid],
          [PROP_LAST_MODIFIED_TIME, ids.createdTime],
        ]),
      ),
    });
  }
  objects.push({ ObjectId: paragraphId, ClassId: CLASS_PARAGRAPH, Properties: paragraphProperties });

  return { blockRef: `{${ids.guidToken}}{${ids.textBodySlot}}`, paragraphId, paragraphProperties, objects };
};

/** The text of the first paragraph in the block a container lists by `blockRef`, read from a fresh model. */
export const blockParagraphText = (model: PodsModel, blockRef: string): string | undefined => {
  const bodyId = refToObjectId(blockRef);
  const body = bodyId ? model.objects.find(o => o.objectId === bodyId && o.classId === CLASS_TEXT_BODY) : undefined;
  if (!body) return undefined;
  const childId = refToObjectId(parseRefList(readProp(body.properties, PROP_ORDERED_CHILDREN) ?? '')[0] ?? '');
  const child = childId ? model.objects.find(o => o.objectId === childId) : undefined;
  return child ? readProp(child.properties, PROP_TEXT) : undefined;
};
