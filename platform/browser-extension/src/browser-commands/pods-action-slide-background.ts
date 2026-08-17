/**
 * Pods `set_slide_background` action — solid background fill on one slide, live.
 *
 * Decoded from the editor's own `FormatBackgroundSolidFill` capture: background
 * fill lives on the SLIDE object (`393227`), not on a shape. The slide is
 * resubmitted as a verbatim copy with four fill properties changed (or appended,
 * on a slide whose background was never set):
 *
 *  - `469780561` — the fill colour in `#RRGGBB,,,` string form
 *  - `469780621` — the structured colour json (RGB, alpha 100, no theme colour)
 *  - `469780560` — the paired empty string the editor writes alongside
 *  - `469780963` — the fill-mode json
 *
 * Everything else — including the slide's resolved theme blob (`469780520`) and
 * its child/render reference lists — is copied through verbatim, never
 * synthesized. The revision names the SLIDE's own storage cell: cells are per
 * slide, and a revision naming the wrong cell is accepted and silently dropped.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  actionDescIdOf,
  CLASS_SLIDE,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  type PodsObject,
  readProp,
  refToObjectId,
  slideRefsOf,
} from './pods-model.js';

/** Slide (393227) background-fill property ids, decoded from the editor's own write. */
const PROP_BG_COLOR_STR = 469780561;
const PROP_BG_COLOR_JSON = 469780621;
const PROP_BG_COLOR_PAIRED = 469780560;
const PROP_BG_FILL_MODE = 469780963;

/** The fill-mode json the editor's solid-fill write carries, copied byte-for-byte. */
const SOLID_FILL_MODE_JSON = '{"noFillField":{},"shadeToTitleField":false}';

/** The client sequence hint the editor's own FormatBackgroundSolidFill capture carried. Not server-validated. */
const REVISION_SEQUENCE = 47;

/** The validated arguments of a `set_slide_background` action. */
export interface SlideBackgroundArgs {
  /** 1-based position of the slide, in the deck's slide order. */
  slideIndex: number;
  /** Six-digit uppercase `RRGGBB` fill colour. */
  colorHex: string;
}

/** The live objects a `set_slide_background` write needs, resolved from the model. */
export interface SlideBackgroundContext {
  /** The target slide's storage cell id. */
  cellId: string;
  /** The action descriptor id (`<presentation action-context guid>|1`). */
  actionDescId: string;
  /** The target slide's object id (`<guid>|<ctr>`). */
  slideObjectId: string;
  /** The slide's full property list, copied so the resubmit changes only the fill. */
  slideProperties: (string | number)[];
  /** The slide's reference in the root slide list — the write's stable identity. */
  slideRef: string;
  /** The slide's current 1-based position. */
  slideIndex: number;
  /** The fill colour before the change (`#RRGGBB,,,` form), when the slide carried one. */
  colorBefore: string | null;
}

/** The `#RRGGBB,,,` wire form of a background colour. */
const bgColorValue = (colorHex: string): string => `#${colorHex},,,`;

/** The structured colour json the editor writes alongside the string form, key order matching its capture. */
const bgColorJson = (colorHex: string): string =>
  JSON.stringify({ Alpha: 100, ColorLuminance: 0, FTintColor: false, RGBColor: colorHex, ThemeColor: -1 });

/** Find the slide object (`393227`) the root's slide list names at a 1-based position. */
const findSlideAt = (
  model: PodsModel,
  slideIndex: number,
): { slide: PodsObject; slideRef: string; root: PodsObject } => {
  const root = findPresentationRoot(model);
  const { slideRefs } = slideRefsOf(root);
  if (!Number.isInteger(slideIndex) || slideIndex < 1 || slideIndex > slideRefs.length) {
    throw new FrameBridgeValidationError(
      `set_slide_background index ${slideIndex} is out of range; the deck has ${slideRefs.length} slide(s).`,
    );
  }
  const slideRef = slideRefs[slideIndex - 1] as string;
  const slideObjectId = refToObjectId(slideRef);
  const slide = slideObjectId ? model.objects.find(o => o.objectId === slideObjectId) : undefined;
  if (!slide || slide.classId !== CLASS_SLIDE) {
    throw new FrameBridgeValidationError(
      `Slide ${slideIndex} (${slideRef}) has no slide object (ClassId ${CLASS_SLIDE}) in the live model.`,
    );
  }
  return { slide, slideRef, root };
};

/**
 * Build the `FormatBackgroundSolidFill` revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The slide is a verbatim copy with the
 * four fill properties overridden — appended when absent, so a background can be
 * set on a slide that never had one — and sorted ascending to match the editor.
 */
export const buildSlideBackgroundBody = (
  ctx: SlideBackgroundContext,
  colorHex: string,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
): Record<string, unknown> => {
  const overrides = new Map<number, string>([
    [PROP_BG_COLOR_STR, bgColorValue(colorHex)],
    [PROP_BG_COLOR_JSON, bgColorJson(colorHex)],
    [PROP_BG_COLOR_PAIRED, ''],
    [PROP_BG_FILL_MODE, SOLID_FILL_MODE_JSON],
  ]);

  const seen = new Set<number>();
  const copied: (string | number)[] = [];
  for (let i = 0; i + 1 < ctx.slideProperties.length; i += 2) {
    const key = ctx.slideProperties[i];
    const value = ctx.slideProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (typeof key === 'number') seen.add(key);
    copied.push(key, (typeof key === 'number' ? overrides.get(key) : undefined) ?? value);
  }
  for (const [propId, value] of overrides) {
    if (!seen.has(propId)) copied.push(propId, value);
  }
  const newSlideProperties = sortPropertiesById(copied);

  const objects = [
    {
      ObjectId: ctx.actionDescId,
      ClassId: 131140,
      Properties: [
        134236193,
        'true',
        335562934,
        '1',
        469780658,
        actionDescriptorJson,
        469780989,
        'FormatBackgroundSolidFill',
      ],
    },
    { ObjectId: ctx.slideObjectId, ClassId: CLASS_SLIDE, Properties: newSlideProperties },
  ];

  const revision = {
    Id: `${guidToken}|2`,
    FileId: null,
    RelativePath: null,
    CellId: ctx.cellId,
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

/** Resolve the target slide and pin its reference from its 1-based index. */
export const resolveSlideBackgroundContext = (model: PodsModel, slideIndex: number): SlideBackgroundContext => {
  const { slide, slideRef, root } = findSlideAt(model, slideIndex);
  return {
    cellId: slide.cellId ?? cellIdOf(root),
    actionDescId: actionDescIdOf(root),
    slideObjectId: slide.objectId,
    slideProperties: slide.properties,
    slideRef,
    slideIndex,
    colorBefore: readProp(slide.properties, PROP_BG_COLOR_STR) ?? null,
  };
};

/** The `set_slide_background` action: a solid background fill on the slide at a 1-based position. */
export const slideBackgroundAction: PodsWriteActionSpec<SlideBackgroundArgs, SlideBackgroundContext> = {
  kind: 'write',
  classFilter: [CLASS_SLIDE],
  parseArgs: raw => {
    if (typeof raw.slideIndex !== 'number' || !Number.isInteger(raw.slideIndex) || raw.slideIndex < 1) {
      throw new FrameBridgeValidationError('set_slide_background needs `slideIndex`: a 1-based slide position.');
    }
    if (typeof raw.colorHex !== 'string' || !/^[0-9a-fA-F]{6}$/.test(raw.colorHex)) {
      throw new FrameBridgeValidationError('set_slide_background needs `colorHex`: a six-digit RRGGBB colour.');
    }
    return { slideIndex: raw.slideIndex, colorHex: raw.colorHex.toUpperCase() };
  },
  resolve: (model, args) => resolveSlideBackgroundContext(model, args.slideIndex),
  // A retry re-locates the slide by its REFERENCE: a conflict means the document
  // moved, and the pinned slide's position may have shifted underneath the write.
  rebind: (model, first) => {
    const root = findPresentationRoot(model);
    const { slideRefs } = slideRefsOf(root);
    const index = slideRefs.indexOf(first.slideRef);
    if (index === -1) {
      throw new FrameBridgeValidationError(
        `Slide ${first.slideRef} is no longer in the deck — it was removed by someone else while this write was in flight.`,
      );
    }
    return resolveSlideBackgroundContext(model, index + 1);
  },
  build: (ctx, args, mint: PodsMint) => {
    const seedHex = mint.seed.replace(/-/g, '').slice(0, 8);
    const actionDescriptorJson = JSON.stringify({
      ActionId: String((Number.parseInt(seedHex, 16) || 0) >>> 0),
      ActionName: 'FormatBackgroundSolidFill',
      ActionTime: mint.actionTime,
    });
    return buildSlideBackgroundBody(ctx, args.colorHex, mint.guidToken, mint.headToken, actionDescriptorJson);
  },
  // Applied when the pinned slide's object carries the requested fill colour.
  isApplied: (model, first, args) => {
    const slide = model.objects.find(o => o.objectId === first.slideObjectId);
    return slide !== undefined && readProp(slide.properties, PROP_BG_COLOR_STR) === bgColorValue(args.colorHex);
  },
  // Re-setting the same fill on the same slide is a harmless overwrite.
  idempotent: true,
  summarize: (ctx, args) => ({
    slideIndex: ctx.slideIndex,
    slideRef: ctx.slideRef,
    colorHex: args.colorHex,
    colorBefore: ctx.colorBefore,
  }),
  dryRunExtras: ctx => ({
    slideIndex: ctx.slideIndex,
    slideRef: ctx.slideRef,
    slideObjectId: ctx.slideObjectId,
    colorBefore: ctx.colorBefore,
  }),
};
