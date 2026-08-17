/**
 * Pods `move_slide` action — reorder a slide within an OPEN deck, live.
 *
 * Decoded from the editor's own `MoveSlideById` capture: the same structural
 * mechanism as add/delete —
 *
 *  - The presentation root (`393271`) is resubmitted with its ordered slide-list
 *    property (`603986975`) REORDERED. **Every other root property is copied
 *    through unchanged**, the invariant that protects the slides themselves.
 *  - A `131140` action descriptor names the action `MoveSlideById`.
 *  - The root "modified" flag (`134236525`) is NOT set — the editor sets it on
 *    delete but omits it on add and move; the flag is per-action mimicry.
 *
 * No slide object appears in the revision: only the root's view of the order
 * changes. Slides are addressed by their 1-based position in the slide list, and
 * `toIndex` names the position the slide occupies AFTER the move.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  actionDescIdOf,
  CLASS_PRESENTATION,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  PROP_SLIDE_LIST,
  slideRefsOf,
} from './pods-model.js';

/** The client sequence hint the editor's own MoveSlideById capture carried. Not server-validated. */
const REVISION_SEQUENCE = 28;

/** The validated arguments of a `move_slide` action. */
export interface MoveSlideArgs {
  /** 1-based position of the slide to move, in the deck's current order. */
  fromIndex: number;
  /** 1-based position the slide occupies after the move. */
  toIndex: number;
}

/** The live objects a `move_slide` write needs, resolved from the model. */
export interface MoveSlideContext {
  /** The presentation root's object id (`<guid>|<ctr>`). */
  rootObjectId: string;
  /** The root's full property list, copied so the resubmit changes only the slide list. */
  rootProperties: (string | number)[];
  /** The slide references parsed from the slide list, in deck order. */
  slideRefs: string[];
  /** The reference of the slide being moved — the write's stable identity. */
  targetRef: string;
  /** The target's current 1-based position. */
  fromIndex: number;
  /** The 1-based position the slide lands at. */
  toIndex: number;
}

/** The slide list with the target moved: remove at `from`, insert at `to` (both 1-based). */
export const reorderSlideRefs = (slideRefs: string[], fromIndex: number, toIndex: number): string[] => {
  const moved = [...slideRefs];
  const [target] = moved.splice(fromIndex - 1, 1);
  if (target === undefined) {
    throw new FrameBridgeValidationError(`move_slide index ${fromIndex} names no slide.`);
  }
  moved.splice(toIndex - 1, 0, target);
  return moved;
};

/**
 * Build the `MoveSlideById` revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The root is a verbatim copy with only
 * the slide list reordered, properties sorted ascending to match the editor's own
 * write. The modified flag is deliberately not added — the editor's move omits it,
 * and on add the server accept-then-drops a revision that carries it.
 */
export const buildMoveSlideBody = (
  ctx: MoveSlideContext,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
): Record<string, unknown> => {
  // Resolve/rebind already validated the target; re-check here so an inconsistent
  // context can never produce a body that silently reorders the wrong slide.
  if (ctx.slideRefs[ctx.fromIndex - 1] !== ctx.targetRef) {
    throw new FrameBridgeValidationError(
      `move_slide context is inconsistent: index ${ctx.fromIndex} does not name ${ctx.targetRef}.`,
    );
  }
  const root = { objectId: ctx.rootObjectId, classId: CLASS_PRESENTATION, properties: ctx.rootProperties };
  const cellId = cellIdOf(root);
  const actionDescId = actionDescIdOf(root);

  const newSlideList = reorderSlideRefs(ctx.slideRefs, ctx.fromIndex, ctx.toIndex).join(',');

  const copied: (string | number)[] = [];
  for (let i = 0; i + 1 < ctx.rootProperties.length; i += 2) {
    const key = ctx.rootProperties[i];
    const value = ctx.rootProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    copied.push(key, key === PROP_SLIDE_LIST ? newSlideList : value);
  }
  const newRootProperties = sortPropertiesById(copied);

  const objects = [
    {
      ObjectId: actionDescId,
      ClassId: 131140,
      Properties: [134236193, 'true', 335562934, '1', 469780658, actionDescriptorJson, 469780989, 'MoveSlideById'],
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

/** Resolve the root and pin the moving slide's reference from its 1-based index. */
export const resolveMoveSlideContext = (model: PodsModel, args: MoveSlideArgs): MoveSlideContext => {
  const root = findPresentationRoot(model);
  const { slideRefs } = slideRefsOf(root);
  for (const [name, index] of [
    ['fromIndex', args.fromIndex],
    ['toIndex', args.toIndex],
  ] as const) {
    if (!Number.isInteger(index) || index < 1 || index > slideRefs.length) {
      throw new FrameBridgeValidationError(
        `move_slide ${name} ${index} is out of range; the deck has ${slideRefs.length} slide(s).`,
      );
    }
  }
  return {
    rootObjectId: root.objectId,
    rootProperties: root.properties,
    slideRefs,
    targetRef: slideRefs[args.fromIndex - 1] as string,
    fromIndex: args.fromIndex,
    toIndex: args.toIndex,
  };
};

/** The `move_slide` action: move the slide at `fromIndex` so it sits at `toIndex`. */
export const moveSlideAction: PodsWriteActionSpec<MoveSlideArgs, MoveSlideContext> = {
  kind: 'write',
  classFilter: [],
  parseArgs: raw => {
    for (const name of ['fromIndex', 'toIndex'] as const) {
      const value = raw[name];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new FrameBridgeValidationError(`move_slide needs \`${name}\`: a 1-based slide position.`);
      }
    }
    const args = { fromIndex: raw.fromIndex as number, toIndex: raw.toIndex as number };
    if (args.fromIndex === args.toIndex) {
      throw new FrameBridgeValidationError(
        `move_slide fromIndex and toIndex are both ${args.fromIndex} — the slide is already there.`,
      );
    }
    return args;
  },
  resolve: resolveMoveSlideContext,
  // A retry re-locates the slide by its REFERENCE, never its position: a conflict
  // means the document moved, so the pinned slide's current index — wherever the
  // concurrent edits left it — becomes the fresh `fromIndex`. The destination the
  // caller asked for stays fixed.
  rebind: (model, first, args) => {
    const root = findPresentationRoot(model);
    const { slideRefs } = slideRefsOf(root);
    const index = slideRefs.indexOf(first.targetRef);
    if (index === -1) {
      throw new FrameBridgeValidationError(
        `Slide ${first.targetRef} is no longer in the deck — it was removed by someone else while this move was in flight.`,
      );
    }
    if (args.toIndex > slideRefs.length) {
      throw new FrameBridgeValidationError(
        `move_slide toIndex ${args.toIndex} is out of range now; the deck has ${slideRefs.length} slide(s).`,
      );
    }
    return {
      rootObjectId: root.objectId,
      rootProperties: root.properties,
      slideRefs,
      targetRef: first.targetRef,
      fromIndex: index + 1,
      toIndex: args.toIndex,
    };
  },
  build: (ctx, _args, mint: PodsMint) => {
    const seedHex = mint.seed.replace(/-/g, '').slice(0, 8);
    const actionDescriptorJson = JSON.stringify({
      ActionId: String((Number.parseInt(seedHex, 16) || 0) >>> 0),
      ActionName: 'MoveSlideById',
      ActionTime: mint.actionTime,
    });
    return buildMoveSlideBody(ctx, mint.guidToken, mint.headToken, actionDescriptorJson);
  },
  // Applied when the pinned reference sits at the destination in the live list.
  isApplied: (model, first, args) =>
    slideRefsOf(findPresentationRoot(model)).slideRefs[args.toIndex - 1] === first.targetRef,
  // Re-issuing a move that already landed rebuilds from the fresh model, finds the
  // slide already at `toIndex`, and writes the unchanged order — a harmless no-op.
  idempotent: true,
  summarize: ctx => ({
    fromIndex: ctx.fromIndex,
    toIndex: ctx.toIndex,
    movedRef: ctx.targetRef,
    slideCountBefore: ctx.slideRefs.length,
  }),
  dryRunExtras: ctx => ({
    fromIndex: ctx.fromIndex,
    toIndex: ctx.toIndex,
    movedRef: ctx.targetRef,
    slideCountBefore: ctx.slideRefs.length,
    rootObjectId: ctx.rootObjectId,
    slideRefs: ctx.slideRefs,
  }),
};
