/**
 * Pods `delete_slide` action — remove a slide from an OPEN deck, live.
 *
 * The exact inverse of `add_slide`, decoded from a clean single-delete capture:
 *
 *  - The presentation root (`393271`) is resubmitted with the target slide's
 *    reference **removed** from its slide-list property (`603986975`). **Every
 *    other root property is copied through unchanged**, so the surviving slides
 *    cannot be scrambled.
 *  - A `131140` action descriptor names the action `DeleteSlide`.
 *
 * There is no slide object in the revision — the server reclaims the now-orphaned
 * slide from the reference removal. Slides are addressed by their 1-based position
 * in the slide list, which is the deck's visual order.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  CLASS_PRESENTATION,
  findPresentationRoot,
  guidOf,
  type PodsModel,
  PROP_ACTION_CTX,
  PROP_SLIDE_LIST,
  readProp,
  slideRefsOf,
} from './pods-model.js';

/**
 * Root "modified" flag. The editor sets this to `"true"` on its own DeleteSlide
 * write, but it is absent from the read-model snapshot — so a verbatim copy of the
 * root omits it. Without it (and without sorting the properties, as the editor
 * does) the server accepts the revision but does not apply the slide-list change.
 * Decoded by diffing a real DeleteSlide capture against a failed attempt. The flag
 * is action-specific mimicry, not a structural-write rule: an add must OMIT it
 * (verified live — setting it makes the server accept-then-drop the add).
 */
const PROP_ROOT_MODIFIED_FLAG = 134236525;

/** The client sequence hint the co-authoring channel carries on a write. Not server-validated (a fresh guid makes each revision unique). */
const REVISION_SEQUENCE = 24;

/** The validated arguments of a `delete_slide` action. */
export interface DeleteSlideArgs {
  /** 1-based position of the slide to delete, in the deck's slide order. */
  slideIndex: number;
}

/** The live objects a `delete_slide` write needs, resolved from the model. */
export interface DeleteSlideContext {
  /** The presentation root's object id (`<guid>|<ctr>`). */
  rootObjectId: string;
  /** The root's full property list, copied so the resubmit changes only the slide list. */
  rootProperties: (string | number)[];
  /** The slide references parsed from the slide list, in deck order. */
  slideRefs: string[];
  /** The reference of the slide being deleted — the write's stable identity. */
  targetRef: string;
  /** The target's current 1-based position. */
  targetIndex: number;
}

/**
 * Build the `DeleteSlide` revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The target slide's reference is removed
 * from the root's slide list; the root is otherwise a verbatim copy, which is what
 * protects the surviving slides.
 */
export const buildDeleteSlideBody = (
  ctx: DeleteSlideContext,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
): Record<string, unknown> => {
  // Resolve/rebind already validated the target; re-check here so an inconsistent
  // context can never produce a body that silently deletes nothing (or the wrong slide).
  if (ctx.slideRefs[ctx.targetIndex - 1] !== ctx.targetRef) {
    throw new FrameBridgeValidationError(
      `delete_slide context is inconsistent: index ${ctx.targetIndex} does not name ${ctx.targetRef}.`,
    );
  }
  const rootGuid = guidOf(ctx.rootObjectId);
  const cellId = `${rootGuid}|3`;

  // Action-descriptor id: the guid from the root's action-context reference, `|1`.
  const actionRef = readProp(ctx.rootProperties, PROP_ACTION_CTX);
  const actionMatch = actionRef?.match(/\{([0-9a-f-]+)\}\{(\d+)\}/i);
  if (!actionMatch) {
    throw new FrameBridgeValidationError('Presentation root has no action-context reference to derive the descriptor.');
  }
  const actionDescId = `${actionMatch[1]}|1`;

  // The slide list with the target reference dropped.
  const newSlideList = ctx.slideRefs.filter((_, i) => i !== ctx.targetIndex - 1).join(',');

  // The root, copied with only the slide list changed, plus the modified flag the
  // editor sets on its DeleteSlide, then sorted ascending by id to match the
  // editor's own write exactly (both are required for the delete to apply).
  let hasModifiedFlag = false;
  const copied: (string | number)[] = [];
  for (let i = 0; i + 1 < ctx.rootProperties.length; i += 2) {
    const key = ctx.rootProperties[i];
    const value = ctx.rootProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_ROOT_MODIFIED_FLAG) hasModifiedFlag = true;
    copied.push(key, key === PROP_SLIDE_LIST ? newSlideList : key === PROP_ROOT_MODIFIED_FLAG ? 'true' : value);
  }
  if (!hasModifiedFlag) copied.push(PROP_ROOT_MODIFIED_FLAG, 'true');
  const newRootProperties = sortPropertiesById(copied);

  const objects = [
    {
      ObjectId: actionDescId,
      ClassId: 131140,
      Properties: [134236193, 'true', 335562934, '1', 469780658, actionDescriptorJson, 469780989, 'DeleteSlide'],
    },
    { ObjectId: ctx.rootObjectId, ClassId: CLASS_PRESENTATION, Properties: newRootProperties },
  ];

  const revision = {
    Id: `${guidToken}|2`,
    FileId: null,
    RelativePath: null,
    CellId: cellId,
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

/** Resolve the root and pin the target slide's reference from its 1-based index. */
export const resolveDeleteSlideContext = (model: PodsModel, slideIndex: number): DeleteSlideContext => {
  const root = findPresentationRoot(model);
  const { slideRefs } = slideRefsOf(root);
  if (!Number.isInteger(slideIndex) || slideIndex < 1 || slideIndex > slideRefs.length) {
    throw new FrameBridgeValidationError(
      `delete_slide index ${slideIndex} is out of range; the deck has ${slideRefs.length} slide(s).`,
    );
  }
  return {
    rootObjectId: root.objectId,
    rootProperties: root.properties,
    slideRefs,
    targetRef: slideRefs[slideIndex - 1] as string,
    targetIndex: slideIndex,
  };
};

/** The `delete_slide` action: remove the slide at a 1-based position from the open deck. */
export const deleteSlideAction: PodsWriteActionSpec<DeleteSlideArgs, DeleteSlideContext> = {
  kind: 'write',
  classFilter: [],
  parseArgs: raw => {
    if (typeof raw.slideIndex !== 'number' || !Number.isInteger(raw.slideIndex) || raw.slideIndex < 1) {
      throw new FrameBridgeValidationError('delete_slide needs `slideIndex`: a 1-based slide position.');
    }
    return { slideIndex: raw.slideIndex };
  },
  resolve: (model, args) => resolveDeleteSlideContext(model, args.slideIndex),
  // A retry re-locates the slide by its REFERENCE, never its position: a conflict
  // means the document moved, and position 3 after a co-author's edit is not the
  // slide the caller asked to delete. Identity survives that; position does not.
  rebind: (model, first) => {
    const root = findPresentationRoot(model);
    const { slideRefs } = slideRefsOf(root);
    const index = slideRefs.indexOf(first.targetRef);
    if (index === -1) {
      throw new FrameBridgeValidationError(
        `Slide ${first.targetRef} is no longer in the deck — it was removed by someone else while this delete was in flight.`,
      );
    }
    return {
      rootObjectId: root.objectId,
      rootProperties: root.properties,
      slideRefs,
      targetRef: first.targetRef,
      targetIndex: index + 1,
    };
  },
  build: (ctx, _args, mint: PodsMint) => {
    const seedHex = mint.seed.replace(/-/g, '').slice(0, 8);
    const actionDescriptorJson = JSON.stringify({
      ActionId: String((Number.parseInt(seedHex, 16) || 0) >>> 0),
      ActionName: 'DeleteSlide',
      ActionTime: mint.actionTime,
    });
    return buildDeleteSlideBody(ctx, mint.guidToken, mint.headToken, actionDescriptorJson);
  },
  // Applied when the target's reference is gone from the live slide list.
  isApplied: (model, first) => !slideRefsOf(findPresentationRoot(model)).slideRefs.includes(first.targetRef),
  // A delete is not idempotent — retrying one that already applied removes a SECOND slide.
  idempotent: false,
  // Reported off the first resolve: `removedRef` is the authoritative identity;
  // `slideIndex` is the position as the caller named it, which a concurrent edit
  // may have shifted by the time the write landed.
  summarize: ctx => ({
    slideIndex: ctx.targetIndex,
    removedRef: ctx.targetRef,
    slideCountBefore: ctx.slideRefs.length,
  }),
  dryRunExtras: ctx => ({
    slideIndex: ctx.targetIndex,
    removedRef: ctx.targetRef,
    slideCountBefore: ctx.slideRefs.length,
    rootObjectId: ctx.rootObjectId,
    slideRefs: ctx.slideRefs,
  }),
};
