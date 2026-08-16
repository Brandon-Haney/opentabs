/**
 * Pods `add_slide` action — insert a new slide into an OPEN deck, live.
 *
 * Decoded from a clean single-add capture; the transformation is small and
 * well-scoped, which is what makes it safe:
 *
 *  - The presentation root (`393271`) is resubmitted with the new slide's reference
 *    inserted into its slide-list property (`603986975`). **Every other root
 *    property is copied through unchanged**, so existing slides cannot be scrambled.
 *  - A new `393227` slide object is created carrying the deck's master id
 *    (`335562835`) and layout id (`335562836`) copied from an existing slide, fresh
 *    creation ids, and its anchor (`536889506`) — the slide it is inserted after,
 *    derived from the live slide list. The anchor appears only on the written slide
 *    object, never in the read model, so it cannot be copied off an existing slide.
 *  - A `131140` action descriptor names the action `NewSlideWithLayout`.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  CLASS_PRESENTATION,
  CLASS_SLIDE,
  findPresentationRoot,
  guidOf,
  type PodsModel,
  PROP_ACTION_CTX,
  PROP_SLIDE_LIST,
  readProp,
  slideRefsOf,
} from './pods-model.js';

/** Slide (393227) property ids: master id, layout id. */
const PROP_MASTER = 335562835;
const PROP_LAYOUT = 335562836;
/**
 * The slide the new slide is inserted AFTER — its anchor position in the deck.
 *
 * Verified against three captured inserts: this value always equals the slide-list
 * entry immediately preceding the new slide's own entry, including one insert at
 * position 2 of 4 (so it tracks position, not a layout). The editor emits it on
 * every insert; it appears only on the written slide object and never in the read
 * model, so it must be derived from the live slide list rather than copied off an
 * existing slide.
 */
const PROP_ANCHOR_SLIDE = 536889506;
/** Slide (393227) creation-id property ids. */
const PROP_CREATE_A = 335562805;
const PROP_CREATE_B = 335562806;

/** The live objects an `add_slide` write needs, resolved from the model. */
export interface AddSlideContext {
  /** The presentation root's object id (`<guid>|<ctr>`). */
  rootObjectId: string;
  /** The root's full property list, copied so the resubmit changes only the slide list. */
  rootProperties: (string | number)[];
  /** The root's current slide-list value (`603986975`). */
  slideList: string;
  /** The slide references parsed from the slide list, in deck order. */
  slideRefs: string[];
  /** Master id and layout id copied from an existing slide. */
  master: string;
  layout: string;
}

/** A stable-per-call creation id derived from a hex guid, so each added slide is distinct. */
const creationIdFrom = (guid: string, salt: number): string => {
  const hex = guid.replace(/-/g, '').slice(0, 8);
  return String((Number.parseInt(hex, 16) ^ salt) >>> 0);
};

/**
 * Build the `NewSlideWithLayout` revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The new slide's reference is appended to
 * the root's slide list, so it lands at the end of the deck; the root is otherwise a
 * verbatim copy. The two creation ids are derived from the minted GUID so each added
 * slide is distinct.
 */
export const buildAddSlideBody = (
  ctx: AddSlideContext,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
  createIdA: string,
  createIdB: string,
): Record<string, unknown> => {
  const rootGuid = guidOf(ctx.rootObjectId);
  const cellId = `${rootGuid}|3`;

  // Action-descriptor id: the guid from the root's action-context reference, `|1`.
  const actionRef = readProp(ctx.rootProperties, PROP_ACTION_CTX);
  const actionMatch = actionRef?.match(/\{([0-9a-f-]+)\}\{(\d+)\}/i);
  if (!actionMatch) {
    throw new FrameBridgeValidationError('Presentation root has no action-context reference to derive the descriptor.');
  }
  const actionDescId = `${actionMatch[1]}|1`;

  // The new slide's own reference token, appended to the root's slide list. The
  // slide it lands after is its anchor.
  const newSlideRef = `{${guidToken}}{1}`;
  const newSlideList = ctx.slideList.length > 0 ? `${ctx.slideList},${newSlideRef}` : newSlideRef;
  const anchorRef = ctx.slideRefs[ctx.slideRefs.length - 1];

  // The root, copied with only the slide list changed, then sorted ascending by id
  // to match the editor's own NewSlideWithLayout write.
  //
  // Deliberately does NOT set the modified flag (134236525) that a delete carries:
  // the editor omits it here, and adding it was verified live to make the server
  // accept the revision and then silently drop it. The flag is action-specific, not
  // a general rule for structural writes.
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
      Properties: [134236193, 'true', 335562934, '1', 469780658, actionDescriptorJson, 469780989, 'NewSlideWithLayout'],
    },
    { ObjectId: ctx.rootObjectId, ClassId: CLASS_PRESENTATION, Properties: newRootProperties },
    {
      ObjectId: `${guidToken}|1`,
      ClassId: CLASS_SLIDE,
      Properties: [
        PROP_CREATE_A,
        createIdA,
        PROP_CREATE_B,
        createIdB,
        PROP_MASTER,
        ctx.master,
        PROP_LAYOUT,
        ctx.layout,
        // Anchor the new slide after the deck's current last slide — an append.
        // The editor emits this on every insert; omitting it is what left an added
        // slide without its layout's placeholders.
        ...(anchorRef ? [PROP_ANCHOR_SLIDE, anchorRef] : []),
      ],
    },
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
          Sequence: 23,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

/** Resolve the presentation root and a template slide's master/layout ids from the model. */
export const resolveAddSlideContext = (model: PodsModel): AddSlideContext => {
  const root = findPresentationRoot(model);
  const { slideList, slideRefs } = slideRefsOf(root);

  // A template slide: an existing 393227 that carries a master and layout id,
  // which the new slide inherits. The anchor is NOT read from here — it is a
  // position, derived from the slide list in the builder.
  const template = model.objects.find(
    o =>
      o.classId === CLASS_SLIDE &&
      readProp(o.properties, PROP_MASTER) !== undefined &&
      readProp(o.properties, PROP_LAYOUT) !== undefined,
  );
  if (!template) {
    throw new FrameBridgeValidationError(
      'No existing slide (393227) with master/layout ids found to template the new slide.',
    );
  }

  return {
    rootObjectId: root.objectId,
    rootProperties: root.properties,
    slideList,
    slideRefs,
    master: readProp(template.properties, PROP_MASTER) as string,
    layout: readProp(template.properties, PROP_LAYOUT) as string,
  };
};

/** Derive the per-call ids and descriptor an add-slide build needs from the mint. */
const derivedMint = (mint: PodsMint) => ({
  createIdA: creationIdFrom(mint.seed, 0),
  createIdB: creationIdFrom(mint.seed, 0x51ed),
  actionDescriptorJson: JSON.stringify({
    ActionId: creationIdFrom(mint.seed, 0xac1),
    ActionName: 'NewSlideWithLayout',
    ActionTime: mint.actionTime,
  }),
});

/** The `add_slide` action: append a layout-templated slide to the open deck. */
export const addSlideAction: PodsWriteActionSpec<Record<string, never>, AddSlideContext> = {
  kind: 'write',
  classFilter: [CLASS_SLIDE],
  parseArgs: () => ({}),
  resolve: model => resolveAddSlideContext(model),
  build: (ctx, _args, mint) => {
    const { createIdA, createIdB, actionDescriptorJson } = derivedMint(mint);
    return buildAddSlideBody(ctx, mint.guidToken, mint.headToken, actionDescriptorJson, createIdA, createIdB);
  },
  // Applied when the live slide list carries a reference the first resolve did not
  // know — the closest available identity check, since the new slide's GUID is
  // minted per attempt below this layer and never surfaces here. Unlike a count
  // comparison, this stays correct when a co-author deletes a slide in the
  // confirmation window; a co-author ADDING a slide in that window can still read
  // as our add having applied, which is the remaining (small) ambiguity.
  isApplied: (model, first) => {
    const { slideRefs } = slideRefsOf(findPresentationRoot(model));
    const known = new Set(first.slideRefs);
    return slideRefs.some(ref => !known.has(ref));
  },
  // An add is not idempotent — retrying one that already applied appends a SECOND slide.
  idempotent: false,
  summarize: ctx => ({ layout: ctx.layout, slideCountBefore: ctx.slideRefs.length }),
  dryRunExtras: ctx => ({
    layout: ctx.layout,
    master: ctx.master,
    slideCountBefore: ctx.slideRefs.length,
    rootObjectId: ctx.rootObjectId,
  }),
};
