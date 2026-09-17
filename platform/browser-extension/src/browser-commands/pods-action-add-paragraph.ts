/**
 * Pods `add_paragraph` action — append a paragraph to a shape in an OPEN deck, live.
 *
 * This is the editor's `NewLine` (pressing Enter), and its shape is surprising: a
 * split does NOT append a paragraph to the text body that already holds one. It
 * appends a whole new block to the shape, and that block holds the new paragraph
 * (see `pods-text-block.ts`).
 *
 * The write is one revision: the action descriptor, the shape (or table cell)
 * with the new block listed directly after the source paragraph's block, the
 * source paragraph resubmitted unchanged, and the
 * new block — born carrying its text. A paragraph born with text is the editor's
 * own `PowerPointPasteGivenText` write, which creates a block and its paragraph's
 * text in the same revision.
 *
 * The new paragraph takes the source's formatting with a single-run layout. The
 * source's own layout describes the source's text: copied onto shorter text it
 * names offsets past the end, the server accepts the write, and the editor client
 * crashes applying it — which loses the paragraph, because the crashed client
 * never persists it.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { typingParagraphAndRun } from './pods-action-set-text.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  actionDescIdOf,
  CLASS_PARAGRAPH,
  CLASS_RUN,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  PROP_CONTENT_REFS,
  PROP_SHAPE_NAME,
  parseRefList,
  readProp,
} from './pods-model.js';
import {
  blockParagraphText,
  buildNewBlock,
  copyWith,
  locateTextBlock,
  TEXT_BLOCK_CLASSES,
  type TextBlockLocation,
} from './pods-text-block.js';

/**
 * Present on a paragraph the editor creates and absent from the one it split off.
 * `WordPersistedProperties` index 52, between `listLevel` and the indent values,
 * and always `"0"` in the captures.
 */
const PROP_NEW_PARAGRAPH_INDENT = 335559732;

/** Object slots minted under the write GUID. Distinct so nothing in the write collides. */
const SLOT_NEW_PARAGRAPH = 1;
const SLOT_REVISION = 2;
const SLOT_GROUP = 3;
const SLOT_NEW_TEXT_BODY = 4;
const SLOT_LIST_MARKER = 5;
const SLOT_TYPING_RUN = 6;

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
export interface AddParagraphContext extends TextBlockLocation {
  /** The storage cell the target's slide lives in. */
  cellId: string;
  /** The action-descriptor object id. */
  actionDescId: string;
  /** The shape's name, for the result; null inside a table cell. */
  shapeName: string | null;
}

/** Find the paragraph to append after, and the block and shape the new paragraph joins. */
export const resolveAddParagraphContext = (model: PodsModel, after: string): AddParagraphContext => {
  const root = findPresentationRoot(model);
  const location = locateTextBlock(model, after);
  return {
    ...location,
    cellId: location.paragraphCellId ?? cellIdOf(root),
    actionDescId: actionDescIdOf(root),
    shapeName: readProp(location.containerProperties, PROP_SHAPE_NAME) ?? null,
  };
};

/**
 * Build the `NewLine` body with identity placeholders.
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
  const block = buildNewBlock(
    ctx,
    text,
    {
      guidToken,
      textBodySlot: SLOT_NEW_TEXT_BODY,
      paragraphSlot: SLOT_NEW_PARAGRAPH,
      listMarkerSlot: SLOT_LIST_MARKER,
      blockOwnerGuid,
      createdTime,
    },
    new Map([[PROP_NEW_PARAGRAPH_INDENT, '0']]),
  );

  // A run carrying its own text must change with the paragraph's, so the new
  // paragraph gets a replacement run rather than sharing the source's.
  const typed = typingParagraphAndRun(block.paragraphProperties, ctx.run, text, `{${guidToken}}{${SLOT_TYPING_RUN}}`);
  const blockObjects = block.objects.map(o =>
    o.ObjectId === block.paragraphId ? { ...o, Properties: typed.paragraphProperties } : o,
  );

  // The new block goes directly after the source's, as the editor's own split
  // places it — appending at the end would put a line after a middle bullet at
  // the bottom of the list.
  const blockRefs = [...ctx.contentRefTokens];
  blockRefs.splice(blockRefs.indexOf(ctx.blockRef) + 1, 0, block.blockRef);
  const containerProperties = copyWith(ctx.containerProperties, new Map([[PROP_CONTENT_REFS, blockRefs.join(',')]]));

  const revision = {
    Id: `${guidToken}|${SLOT_REVISION}`,
    FileId: null,
    RelativePath: null,
    CellId: ctx.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: headToken,
    RootObjectDescriptors: null,
    ObjectGroups: [
      {
        Id: `${guidToken}|${SLOT_GROUP}`,
        Objects: [
          {
            ObjectId: ctx.actionDescId,
            ClassId: 131140,
            Properties: [134236193, 'true', 335562934, '1', 469780658, actionDescriptorJson, 469780989, 'NewLine'],
          },
          { ObjectId: ctx.containerObjectId, ClassId: ctx.containerClassId, Properties: containerProperties },
          {
            ObjectId: ctx.paragraphId,
            ClassId: CLASS_PARAGRAPH,
            Properties: sortPropertiesById(ctx.paragraphProperties),
          },
          ...blockObjects,
          ...(typed.runProperties
            ? [{ ObjectId: `${guidToken}|${SLOT_TYPING_RUN}`, ClassId: CLASS_RUN, Properties: typed.runProperties }]
            : []),
        ],
      },
    ],
    IsFolderCell: false,
  };

  return {
    Mode: 4,
    srs: [
      [
        3,
        {
          OperationId: 1,
          DependentOn: 0,
          Revisions: [revision],
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
  classFilter: TEXT_BLOCK_CLASSES,
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
   * paragraph inside it carries the requested text — the text, not just the block,
   * so a co-author splitting a paragraph in this shape at the same moment cannot
   * confirm this write.
   */
  isApplied: (model, first, args) => {
    const container = model.objects.find(o => o.objectId === first.containerObjectId);
    if (!container) return false;
    const known = new Set(first.contentRefTokens);
    return parseRefList(readProp(container.properties, PROP_CONTENT_REFS) ?? '')
      .filter(ref => !known.has(ref))
      .some(ref => blockParagraphText(model, ref) === args.text);
  },
  // An append is not idempotent — retrying one that already applied adds a SECOND paragraph.
  idempotent: false,
  summarize: (ctx, args) => ({
    after: args.after,
    text: args.text,
    shape: ctx.shapeName,
    sourceParagraphId: ctx.paragraphId,
    blocksBefore: ctx.contentRefTokens.length,
  }),
  dryRunExtras: (ctx, args) => ({
    after: args.after,
    text: args.text,
    shape: ctx.shapeName,
    sourceParagraphId: ctx.paragraphId,
  }),
};
