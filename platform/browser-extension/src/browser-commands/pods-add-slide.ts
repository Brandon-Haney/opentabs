/**
 * Pods `add_slide` engine — insert a new slide into an OPEN deck, live.
 *
 * Adding a slide is a co-authoring revision on the `/pods/PowerPoint.ashx` channel,
 * the same transport as {@link runPodsSetFontSize}. Decoded from a clean single-add
 * capture, the transformation is small and well-scoped, which is what makes it safe:
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
 *
 * The engine reads the LIVE model in the editor frame (a type-2 poll from the zero
 * base, so it reflects co-authoring edits), resolves the root and a template slide
 * there, returns only the small slice needed, and constructs the revision in the
 * service worker with identity placeholders — handing it to {@link runPodsBridge}
 * for the head read, GUID mint, substitution, POST, and conflict retry.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { BRIDGE_REPLAY_DEPTH_GLOBAL, FORBIDDEN_REPLAY_HEADERS } from './frame-fetch.js';
import {
  freshAfterFirst,
  type PodsBridgeParams,
  type PodsBridgeResult,
  runPodsWriteConfirmed,
  sortPropertiesById,
} from './pods-bridge.js';

const CLASS_PRESENTATION = 393271;
const CLASS_SLIDE = 393227;
/** Root property holding the ordered slide list (`{guid}{ctr},…`). Inserting the new slide here is the whole root change. */
const PROP_SLIDE_LIST = 603986975;
/** Root property whose guid seeds the action descriptor id. */
const PROP_ACTION_CTX = 536889540;
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

const DEFAULT_GUID_TOKEN = '__OTB_PODS_GUID__';
const DEFAULT_HEAD_TOKEN = '__OTB_PODS_HEAD__';

/** Directive parameters for an `add_slide` write. Unlike text ops, it targets no text. */
export interface PodsAddSlideParams {
  tabId: number;
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  /** The `{Mode:4,srs:[[2,…]]}` live-model poll body (type-2, zero base). */
  modelReadBody: string;
  guidToken?: string;
  headToken?: string;
  /** When true, resolve and construct the revision but do NOT write it — returns the body for inspection. */
  dryRun?: boolean;
}

/** The live objects an `add_slide` write needs, read from the editor's model. */
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
  const rootGuid = ctx.rootObjectId.split('|')[0] ?? ctx.rootObjectId;
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
  // to match the editor's own NewSlideWithLayout write (which sorts; unlike delete,
  // an add carries no root modified flag).
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

/** Read a property value from a flat `[id, value, …]` list. */
const readProp = (properties: (string | number)[], id: number): string | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return String(properties[i + 1]);
  return undefined;
};

/** In-frame result: an error, or the resolved add-slide context. */
type ResolveResult = { error: string } | { context: AddSlideContext };

/**
 * Read the live model in the editor frame and resolve the presentation root and a
 * template slide's layout references, returning only that small slice. Runs a
 * type-2 poll from the zero base so the model reflects live co-authoring edits, and
 * rebuilds the current document latest-wins per object id.
 */
const resolveAddSlideContext = async (params: PodsAddSlideParams): Promise<AddSlideContext> => {
  const frameProbe = await chrome.scripting.executeScript({
    target: { tabId: params.tabId, allFrames: true },
    world: 'MAIN',
    func: (donorName: string) => ({
      href: location.href,
      hasDonor: Boolean((globalThis as Record<string, unknown>)[donorName]),
    }),
    args: [params.donorGlobal],
  });
  const info = (frame: (typeof frameProbe)[number]): { href?: string; hasDonor?: boolean } =>
    (frame.result as { href?: string; hasDonor?: boolean } | undefined) ?? {};
  const urlMatches = frameProbe.filter(frame => info(frame).href?.includes(params.frameUrlIncludes));
  const match =
    urlMatches.find(frame => info(frame).hasDonor) ?? frameProbe.find(frame => info(frame).hasDonor) ?? urlMatches[0];
  if (!match || match.frameId === undefined) {
    throw new FrameBridgeValidationError(
      `No editor frame in tab ${params.tabId} with a URL containing "${params.frameUrlIncludes}".`,
    );
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: params.tabId, frameIds: [match.frameId] },
    world: 'MAIN',
    func: async (
      donorName: string,
      modelReadBody: string,
      depthGlobal: string,
      forbidden: string[],
      classPresentation: number,
      classSlide: number,
      propSlideList: number,
      propMaster: number,
      propLayout: number,
    ): Promise<ResolveResult> => {
      const donor = (globalThis as Record<string, unknown>)[donorName] as
        | { url?: string; headers?: Record<string, string> }
        | undefined;
      if (!donor || typeof donor.url !== 'string') {
        return { error: `No donor request is stashed under "${donorName}". Open and activate the deck, then retry.` };
      }
      const forbiddenSet = new Set(forbidden);
      const headers: Record<string, string> = {};
      if (donor.headers && typeof donor.headers === 'object') {
        for (const [name, value] of Object.entries(donor.headers)) {
          if (typeof value === 'string' && !forbiddenSet.has(name.toLowerCase()) && name.toLowerCase() !== 'postdata') {
            headers[name] = value;
          }
        }
      }
      const scope = globalThis as unknown as Record<string, number | undefined>;
      let text: string;
      try {
        scope[depthGlobal] = (scope[depthGlobal] ?? 0) + 1;
        let response: Response;
        try {
          response = await fetch(donor.url, { method: 'POST', headers, credentials: 'include', body: modelReadBody });
        } finally {
          scope[depthGlobal] = (scope[depthGlobal] ?? 1) - 1;
        }
        text = await response.text();
      } catch (err) {
        return { error: `Live-model read failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      let root: unknown;
      try {
        root = JSON.parse(text);
      } catch {
        return { error: `Live-model response was not JSON: ${text.slice(0, 120)}` };
      }

      const byId = new Map<string, { classId: number; objectId: string; properties: (string | number)[] }>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const child of node) walk(child);
          return;
        }
        if (node && typeof node === 'object') {
          const obj = node as Record<string, unknown>;
          if (typeof obj.ClassId === 'number' && typeof obj.ObjectId === 'string' && Array.isArray(obj.Properties)) {
            byId.set(obj.ObjectId, {
              classId: obj.ClassId,
              objectId: obj.ObjectId,
              properties: obj.Properties as (string | number)[],
            });
          }
          for (const value of Object.values(obj)) walk(value);
        }
      };
      walk(root);
      const objects = [...byId.values()];

      const prop = (properties: (string | number)[], id: number): string | undefined => {
        for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return String(properties[i + 1]);
        return undefined;
      };

      const presentation = objects.find(o => o.classId === classPresentation);
      if (!presentation) return { error: 'Live model carried no presentation root (ClassId 393271).' };
      const slideList = prop(presentation.properties, propSlideList);
      if (slideList === undefined) return { error: 'Presentation root has no slide-list property (603986975).' };

      // A template slide: an existing 393227 that carries a master and layout id,
      // which the new slide inherits. The anchor is NOT read from here — it is a
      // position, derived from the slide list below.
      const template = objects.find(
        o =>
          o.classId === classSlide &&
          prop(o.properties, propMaster) !== undefined &&
          prop(o.properties, propLayout) !== undefined,
      );
      if (!template) {
        return { error: 'No existing slide (393227) with master/layout ids found to template the new slide.' };
      }

      return {
        context: {
          rootObjectId: presentation.objectId,
          rootProperties: presentation.properties,
          slideList,
          slideRefs: slideList.split(',').filter(Boolean),
          master: prop(template.properties, propMaster) as string,
          layout: prop(template.properties, propLayout) as string,
        },
      };
    },
    args: [
      params.donorGlobal,
      params.modelReadBody,
      BRIDGE_REPLAY_DEPTH_GLOBAL,
      [...FORBIDDEN_REPLAY_HEADERS],
      CLASS_PRESENTATION,
      CLASS_SLIDE,
      PROP_SLIDE_LIST,
      PROP_MASTER,
      PROP_LAYOUT,
    ],
  });

  const result = results[0]?.result as ResolveResult | undefined;
  if (!result) throw new FrameBridgeValidationError(`Add-slide resolve returned no result for tab ${params.tabId}.`);
  if ('error' in result) throw new FrameBridgeValidationError(result.error);
  return result.context;
};

/** What `add_slide` returns: the write result plus the layout it templated from. */
export interface PodsAddSlideResult extends PodsBridgeResult {
  /** The layout id the new slide was built from. */
  layout: string;
  /** The number of slide entries in the root's slide list before the add. */
  slideCountBefore: number;
}

/** A dry-run result: the constructed revision with identity tokens, not written. */
export interface PodsAddSlideDryRun {
  dryRun: true;
  layout: string;
  master: string;
  slideCountBefore: number;
  rootObjectId: string;
  /** The revision body with `__OTB_PODS_GUID__`/`__OTB_PODS_HEAD__` placeholders, for inspection/verification. */
  body: Record<string, unknown>;
}

/** A stable-per-call creation id derived from a hex guid, so each added slide is distinct. */
const creationIdFrom = (guid: string, salt: number): string => {
  const hex = guid.replace(/-/g, '').slice(0, 8);
  return String((Number.parseInt(hex, 16) ^ salt) >>> 0);
};

/**
 * Resolve the live root and a template slide, construct the `NewSlideWithLayout`
 * revision, and write it. Appends the new slide to the end of the deck.
 */
export const runPodsAddSlide = async (params: PodsAddSlideParams): Promise<PodsAddSlideResult | PodsAddSlideDryRun> => {
  const guidToken = params.guidToken ?? DEFAULT_GUID_TOKEN;
  const headToken = params.headToken ?? DEFAULT_HEAD_TOKEN;
  const ctx = await resolveAddSlideContext(params);

  // Creation ids and action metadata are minted per call. The GUID token is
  // substituted by the engine, so derive the creation ids from a fresh GUID here.
  const seed = crypto.randomUUID();
  const createIdA = creationIdFrom(seed, 0);
  const createIdB = creationIdFrom(seed, 0x51ed);
  const actionDescriptorJson = JSON.stringify({
    ActionId: creationIdFrom(seed, 0xac1),
    ActionName: 'NewSlideWithLayout',
    ActionTime: String(Date.now()),
  });

  const body = buildAddSlideBody(ctx, guidToken, headToken, actionDescriptorJson, createIdA, createIdB);
  const slideCountBefore = ctx.slideList.split(',').filter(Boolean).length;

  if (params.dryRun) {
    return {
      dryRun: true,
      layout: ctx.layout,
      master: ctx.master,
      slideCountBefore,
      rootObjectId: ctx.rootObjectId,
      body,
    };
  }

  // Re-derive the revision on every attempt: a retry follows a conflict, so the
  // slide list (which this revision resubmits whole) has moved, and the anchor must
  // be the deck's current last slide rather than the one read before the first try.
  const nextContext = freshAfterFirst(ctx, () => resolveAddSlideContext(params));
  const bridgeParams: PodsBridgeParams = {
    tabId: params.tabId,
    frameUrlIncludes: params.frameUrlIncludes,
    donorGlobal: params.donorGlobal,
    headSentinel: params.headSentinel,
    body: async () =>
      buildAddSlideBody(await nextContext(), guidToken, headToken, actionDescriptorJson, createIdA, createIdB),
    guidToken,
    headToken,
  };
  // Confirm against the document rather than the response: the slide list must have
  // grown. An add is not idempotent — retrying one that already applied would append
  // a second slide — so an unconfirmed write is reported, never re-issued.
  const result = await runPodsWriteConfirmed(bridgeParams, {
    readState: () => resolveAddSlideContext(params),
    isApplied: state => state.slideList.split(',').filter(Boolean).length > slideCountBefore,
    idempotent: false,
  });

  return {
    ...result,
    layout: ctx.layout,
    slideCountBefore,
  };
};
