/**
 * Pods `set_text` action — replace a paragraph's text in an OPEN deck, live.
 *
 * Decoded from the editor's own captured `Typing` write, which is far simpler
 * than the formatting revisions: an action descriptor plus the paragraph
 * (`393230`) resubmitted with its full property list, where the text property
 * (`469769250`) carries the paragraph's ENTIRE current text. No run object is
 * written — the run references stay pointed at the existing runs, which keep
 * supplying the formatting. So a text replacement is the proven
 * copy-verbatim-and-patch-one-property shape applied to the paragraph itself.
 *
 * A paragraph with more than one run segment takes a different write, decoded
 * from the editor typing over a whole three-run paragraph
 * (`PowerPointPasteGivenText`): the editor does not patch the paragraph at all.
 * It builds a fresh block holding one single-run paragraph with the new text and
 * swaps it into the container's block list in place of the old block. Patching
 * the paragraph in place instead leaves its run offsets describing text that is
 * gone, which crashes the editor client.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { type ResolvedTarget, resolveRunFormatTarget } from './pods-action-run-format.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  CLASS_PARAGRAPH,
  CLASS_RUN,
  type PodsModel,
  PROP_CONTENT_REFS,
  PROP_RUN_REF,
  PROP_TEXT,
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

/** The client sequence hint the captured Typing write carried. Not server-validated. */
const REVISION_SEQUENCE = 37;

/** Object slots the block replacement mints under the write GUID. */
const SLOT_BLOCK_REVISION = 1;
const SLOT_BLOCK_GROUP = 2;
const SLOT_BLOCK_TEXT_BODY = 3;
const SLOT_BLOCK_PARAGRAPH = 4;
const SLOT_BLOCK_LIST_MARKER = 5;
const SLOT_BLOCK_RUN = 6;

/** The validated arguments of a `set_text` action. */
export interface SetTextArgs {
  /** Exact visible text of the target paragraph, as it is now. */
  text: string;
  /** The replacement text. */
  newText: string;
}

/** The objects a `Typing` write carries: the paragraph, and a run when one is needed. */
export interface TypingObjects {
  paragraphProperties: (string | number)[];
  /**
   * A replacement run, present only when the existing run carries its own text.
   * A paragraph whose text diverges from its run's makes the editor reconcile by
   * splitting in a second run and re-generating deleted text under the user, so
   * such a run is replaced rather than shared.
   */
  runProperties?: (string | number)[];
}

/**
 * Build the paragraph — and, where the run carries text, the replacement run — that
 * a `Typing` write submits to put `newText` into a paragraph.
 *
 * Shared with `add_paragraph`, whose chained third revision types into a paragraph
 * the same POST created: the run-text rule is subtle enough that a second
 * implementation of it would be a second place to get it wrong.
 */
export const typingParagraphAndRun = (
  paragraphProperties: (string | number)[],
  run: { properties: (string | number)[] },
  newText: string,
  runRefToken: string,
): TypingObjects => {
  const runCarriesText = readProp(run.properties, PROP_TEXT) !== undefined;

  const newParagraphProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < paragraphProperties.length; i += 2) {
    const key = paragraphProperties[i];
    const value = paragraphProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_TEXT) {
      newParagraphProperties.push(key, newText);
    } else if (key === PROP_RUN_REF && runCarriesText) {
      // The replacement run takes over the reference, exactly as in run-format.
      newParagraphProperties.push(key, runRefToken);
    } else {
      newParagraphProperties.push(key, value);
    }
  }
  if (!runCarriesText) return { paragraphProperties: sortPropertiesById(newParagraphProperties) };

  const newRunProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < run.properties.length; i += 2) {
    const key = run.properties[i];
    const value = run.properties[i + 1];
    if (key === undefined || value === undefined) continue;
    newRunProperties.push(key, key === PROP_TEXT ? newText : value);
  }
  return {
    paragraphProperties: sortPropertiesById(newParagraphProperties),
    runProperties: sortPropertiesById(newRunProperties),
  };
};

/**
 * Build the `Typing` revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The paragraph is resubmitted with
 * every property copied verbatim except the text, then sorted ascending by id —
 * matching the editor's own Typing write, whose paragraph carries the full
 * current property list with the new text in `469769250`.
 *
 * When the run carries its OWN text property, the write must keep it in step:
 * a paragraph whose text diverges from its run's makes the editor reconcile by
 * splitting in a second run and re-generating deleted text under the user
 * (observed live). The proven mechanism for changing a run is the run-format
 * shape — mint a replacement run and rewrite the paragraph's run-reference — so
 * such a write carries a new run with the text patched, exactly like
 * `format_text` but for the text property. A run with no text property (the
 * common case for pre-existing deck text) keeps the paragraph-only Typing shape.
 *
 * Single-run paragraphs only; {@link buildReplaceBlockBody} writes the rest.
 */
export const buildSetTextBody = (
  target: ResolvedTarget,
  newText: string,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => {
  const [run, ...extraRuns] = target.textRuns;
  if (!run || extraRuns.length > 0) {
    throw new FrameBridgeValidationError(
      `The in-place Typing write covers single-run text; "${target.paragraphId}" has ${target.textRuns.length} ` +
        'run segments and must be replaced as a block.',
    );
  }
  const typed = typingParagraphAndRun(target.paragraphProperties, run, newText, `{${guidToken}}{1}`);

  const objects = [
    {
      ObjectId: target.actionDescId,
      ClassId: 131140,
      Properties: [134236193, 'true', 335562934, '1', 469780989, 'Typing'],
    },
    { ObjectId: target.paragraphId, ClassId: CLASS_PARAGRAPH, Properties: typed.paragraphProperties },
    ...(typed.runProperties
      ? [{ ObjectId: `${guidToken}|1`, ClassId: CLASS_RUN, Properties: typed.runProperties }]
      : []),
  ];

  const revision = {
    Id: `${guidToken}|2`,
    FileId: null,
    RelativePath: null,
    CellId: target.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: headToken,
    RootObjectDescriptors: null,
    ObjectGroups: [{ Id: `${guidToken}|3`, Objects: objects }],
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

/** Where a multi-run paragraph's replacement block goes, and what it is modelled on. */
export interface BlockReplacement extends TextBlockLocation {
  cellId: string;
}

/**
 * Build the block-replacement body: the editor's own write for typing over a
 * whole multi-run paragraph.
 *
 * One revision carrying the action descriptor, the container with the old block's
 * reference replaced by the new one's, and the new block. The old block is simply
 * no longer listed — the editor's write does not delete it either.
 */
export const buildReplaceBlockBody = (
  target: ResolvedTarget,
  block: BlockReplacement,
  newText: string,
  guidToken: string,
  headToken: string,
  blockOwnerGuid: string,
  actionDescriptorJson: string,
  createdTime: string,
): Record<string, unknown> => {
  const created = buildNewBlock(block, newText, {
    guidToken,
    textBodySlot: SLOT_BLOCK_TEXT_BODY,
    paragraphSlot: SLOT_BLOCK_PARAGRAPH,
    listMarkerSlot: SLOT_BLOCK_LIST_MARKER,
    blockOwnerGuid,
    createdTime,
  });
  const typed = typingParagraphAndRun(
    created.paragraphProperties,
    block.run,
    newText,
    `{${guidToken}}{${SLOT_BLOCK_RUN}}`,
  );
  const blockObjects = created.objects.map(o =>
    o.ObjectId === created.paragraphId ? { ...o, Properties: typed.paragraphProperties } : o,
  );

  const blockRefs = block.contentRefTokens.map(ref => (ref === block.blockRef ? created.blockRef : ref));
  const containerProperties = copyWith(block.containerProperties, new Map([[PROP_CONTENT_REFS, blockRefs.join(',')]]));

  const revision = {
    Id: `${guidToken}|${SLOT_BLOCK_REVISION}`,
    FileId: null,
    RelativePath: null,
    CellId: block.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: headToken,
    RootObjectDescriptors: null,
    ObjectGroups: [
      {
        Id: `${guidToken}|${SLOT_BLOCK_GROUP}`,
        Objects: [
          {
            ObjectId: target.actionDescId,
            ClassId: 131140,
            Properties: [134236193, 'true', 335562934, '1', 469780658, actionDescriptorJson, 469780989, 'Typing'],
          },
          { ObjectId: block.containerObjectId, ClassId: block.containerClassId, Properties: containerProperties },
          ...blockObjects,
          ...(typed.runProperties
            ? [{ ObjectId: `${guidToken}|${SLOT_BLOCK_RUN}`, ClassId: CLASS_RUN, Properties: typed.runProperties }]
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

/** A resolved `set_text` target: the paragraph, and its block when the write must replace it. */
export interface SetTextContext {
  target: ResolvedTarget;
  /** Present when the paragraph has more than one run segment. */
  block: BlockReplacement | null;
}

/** Resolve a `set_text` target on the slide, with its block for when the paragraph needs a block replacement. */
export const resolveSetTextContext = (model: PodsModel, text: string): SetTextContext => {
  // Locate first: a replaced block's retired paragraph keeps its old text, so the
  // first text match is not necessarily the paragraph on the slide.
  const location = locateTextBlock(model, text);
  const target = resolveRunFormatTarget(model, text, { paragraphId: location.paragraphId });
  if (target.textRuns.length <= 1) return { target, block: null };
  if (location.blockParagraphRefs.length > 1) {
    throw new FrameBridgeValidationError(
      `"${text}" has ${target.textRuns.length} run segments and shares its text block with ` +
        `${location.blockParagraphRefs.length - 1} other paragraph(s), so replacing its block would remove them too.`,
    );
  }
  return { target, block: { ...location, cellId: target.cellId } };
};

/** The target paragraph's current text, read fresh from a model. */
const textOfParagraph = (model: PodsModel, paragraphId: string): string | undefined => {
  const paragraph = model.objects.find(o => o.classId === CLASS_PARAGRAPH && o.objectId === paragraphId);
  return paragraph ? readProp(paragraph.properties, PROP_TEXT) : undefined;
};

/** The `set_text` action: replace the text of the paragraph matched by its current visible text. */
export const setTextAction: PodsWriteActionSpec<SetTextArgs, SetTextContext> = {
  kind: 'write',
  classFilter: TEXT_BLOCK_CLASSES,
  parseArgs: raw => {
    if (typeof raw.text !== 'string' || raw.text.length === 0) {
      throw new FrameBridgeValidationError('set_text needs `text`: the exact current visible text of the paragraph.');
    }
    if (typeof raw.newText !== 'string') {
      throw new FrameBridgeValidationError('set_text needs `newText`: the replacement text.');
    }
    if (raw.newText === raw.text) {
      throw new FrameBridgeValidationError('set_text `newText` is identical to `text` — nothing to change.');
    }
    if (raw.newText.includes('\n')) {
      throw new FrameBridgeValidationError(
        'set_text replaces a single paragraph and cannot insert line breaks yet — pass single-line text.',
      );
    }
    return { text: raw.text, newText: raw.newText };
  },
  resolve: (model, args) => resolveSetTextContext(model, args.text),
  build: (ctx, args, mint: PodsMint) =>
    ctx.block
      ? buildReplaceBlockBody(
          ctx.target,
          ctx.block,
          args.newText,
          mint.guidToken,
          mint.headToken,
          mint.seed,
          JSON.stringify({ ActionId: mint.seed, ActionName: 'PowerPointPasteGivenText', ActionTime: mint.actionTime }),
          mint.actionTime,
        )
      : buildSetTextBody(ctx.target, args.newText, mint.guidToken, mint.headToken),
  // Applied when the change is visible at its own identity, never by a text search,
  // so an unrelated paragraph that already says `newText` can never confirm it: the
  // SAME paragraph now carries the text, or — for a block replacement — the old
  // block is gone from its container and a block it did not list carries the text.
  isApplied: (model, first, args) => {
    const { block } = first;
    if (!block) return textOfParagraph(model, first.target.paragraphId) === args.newText;
    const container = model.objects.find(o => o.objectId === block.containerObjectId);
    if (!container) return false;
    const refs = parseRefList(readProp(container.properties, PROP_CONTENT_REFS) ?? '');
    const known = new Set(block.contentRefTokens);
    return (
      !refs.includes(block.blockRef) &&
      refs.filter(ref => !known.has(ref)).some(ref => blockParagraphText(model, ref) === args.newText)
    );
  },
  // Never auto-re-issued: after a successful apply, the old text is gone, so a
  // re-resolve by it would fail; and a genuinely dropped write should be
  // re-attempted deliberately, against a re-read deck, not blindly.
  idempotent: false,
  summarize: (ctx, args) => ({
    text: args.text,
    newText: args.newText,
    paragraphId: ctx.target.paragraphId,
    runId: ctx.target.textRuns[0]?.objectId ?? '',
    replacedBlock: ctx.block !== null,
  }),
  dryRunExtras: (ctx, args) => ({
    text: args.text,
    newText: args.newText,
    paragraphId: ctx.target.paragraphId,
    replacedBlock: ctx.block !== null,
  }),
};
