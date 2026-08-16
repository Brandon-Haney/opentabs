/**
 * Pods `delete_slide` engine — remove a slide from an OPEN deck, live.
 *
 * Deleting a slide is a co-authoring revision on the `/pods/PowerPoint.ashx`
 * channel, the exact inverse of {@link runPodsAddSlide}. Decoded from a clean
 * single-delete capture, the transformation is small and well-scoped:
 *
 *  - The presentation root (`393271`) is resubmitted with the target slide's
 *    reference **removed** from its slide-list property (`603986975`). **Every
 *    other root property is copied through unchanged**, so the surviving slides
 *    cannot be scrambled.
 *  - A `131140` action descriptor names the action `DeleteSlide`.
 *
 * There is no slide object in the revision — the server reclaims the now-orphaned
 * slide from the reference removal. Slides are addressed by their 1-based position
 * in the slide list, which is the deck's visual order, so deleting position N
 * removes the Nth slide.
 *
 * The engine reads the LIVE model in the editor frame (a type-2 poll from the zero
 * base, so it reflects co-authoring edits), resolves the root and its ordered slide
 * list there, returns only that small slice, and constructs the revision in the
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
/** Root property holding the ordered slide list (`{guid}{ctr},…`). Removing the target ref here is the whole root change. */
const PROP_SLIDE_LIST = 603986975;
/** Root property whose guid seeds the action descriptor id. */
const PROP_ACTION_CTX = 536889540;
/**
 * Root "modified" flag. The editor sets this to `"true"` on every structural
 * slide-list write, but it is absent from the read-model snapshot — so a verbatim
 * copy of the root omits it. Without it (and without sorting the properties, as the
 * editor does) the server accepts the revision but does not apply the slide-list
 * change. Decoded by diffing a real DeleteSlide capture against a failed attempt.
 */
const PROP_ROOT_MODIFIED_FLAG = 134236525;

/** The client sequence hint the co-authoring channel carries on a write. Not server-validated (a fresh guid makes each revision unique). */
const REVISION_SEQUENCE = 24;

const DEFAULT_GUID_TOKEN = '__OTB_PODS_GUID__';
const DEFAULT_HEAD_TOKEN = '__OTB_PODS_HEAD__';

/** Directive parameters for a `delete_slide` write. */
export interface PodsDeleteSlideParams {
  tabId: number;
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  /** The `{Mode:4,srs:[[2,…]]}` live-model poll body (type-2, zero base). */
  modelReadBody: string;
  /** 1-based position of the slide to delete, in the deck's slide order. */
  slideIndex: number;
  guidToken?: string;
  headToken?: string;
  /** When true, resolve and construct the revision but do NOT write it — returns the body for inspection. */
  dryRun?: boolean;
}

/** The live objects a `delete_slide` write needs, read from the editor's model. */
export interface DeleteSlideContext {
  /** The presentation root's object id (`<guid>|<ctr>`). */
  rootObjectId: string;
  /** The root's full property list, copied so the resubmit changes only the slide list. */
  rootProperties: (string | number)[];
  /** The root's current slide-list value (`603986975`). */
  slideList: string;
  /** The slide references parsed from the slide list, in deck order. */
  slideRefs: string[];
}

/** Read a property value from a flat `[id, value, …]` list. */
const readProp = (properties: (string | number)[], id: number): string | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return String(properties[i + 1]);
  return undefined;
};

/**
 * Build the `DeleteSlide` revision body with identity placeholders.
 *
 * Pure and deterministic for unit testing. The target slide's reference is removed
 * from the root's slide list; the root is otherwise a verbatim copy, which is what
 * protects the surviving slides. Throws if the index is out of range.
 */
export const buildDeleteSlideBody = (
  ctx: DeleteSlideContext,
  slideIndex: number,
  guidToken: string,
  headToken: string,
  actionDescriptorJson: string,
): Record<string, unknown> => {
  if (!Number.isInteger(slideIndex) || slideIndex < 1 || slideIndex > ctx.slideRefs.length) {
    throw new FrameBridgeValidationError(
      `delete_slide index ${slideIndex} is out of range; the deck has ${ctx.slideRefs.length} slide(s).`,
    );
  }

  const rootGuid = ctx.rootObjectId.split('|')[0] ?? ctx.rootObjectId;
  const cellId = `${rootGuid}|3`;

  // Action-descriptor id: the guid from the root's action-context reference, `|1`.
  const actionRef = readProp(ctx.rootProperties, PROP_ACTION_CTX);
  const actionMatch = actionRef?.match(/\{([0-9a-f-]+)\}\{(\d+)\}/i);
  if (!actionMatch) {
    throw new FrameBridgeValidationError('Presentation root has no action-context reference to derive the descriptor.');
  }
  const actionDescId = `${actionMatch[1]}|1`;

  // The slide list with the target reference dropped.
  const newSlideList = ctx.slideRefs.filter((_, i) => i !== slideIndex - 1).join(',');

  // The root, copied with only the slide list changed, plus the modified flag the
  // editor sets on a structural write, then sorted ascending by id to match the
  // editor's own DeleteSlide exactly (both are required for the write to apply).
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

/** In-frame result: an error, or the resolved delete-slide context. */
type ResolveResult = { error: string } | { context: DeleteSlideContext };

/**
 * Read the live model in the editor frame and resolve the presentation root and its
 * ordered slide list, returning only that small slice. Runs a type-2 poll from the
 * zero base so the model reflects live co-authoring edits, and rebuilds the current
 * document latest-wins per object id.
 */
const resolveDeleteSlideContext = async (params: PodsDeleteSlideParams): Promise<DeleteSlideContext> => {
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
      propSlideList: number,
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
      const slideRefs = slideList.split(',').filter(Boolean);

      return {
        context: {
          rootObjectId: presentation.objectId,
          rootProperties: presentation.properties,
          slideList,
          slideRefs,
        },
      };
    },
    args: [
      params.donorGlobal,
      params.modelReadBody,
      BRIDGE_REPLAY_DEPTH_GLOBAL,
      [...FORBIDDEN_REPLAY_HEADERS],
      CLASS_PRESENTATION,
      PROP_SLIDE_LIST,
    ],
  });

  const result = results[0]?.result as ResolveResult | undefined;
  if (!result) throw new FrameBridgeValidationError(`Delete-slide resolve returned no result for tab ${params.tabId}.`);
  if ('error' in result) throw new FrameBridgeValidationError(result.error);
  return result.context;
};

/** What `delete_slide` returns: the write result plus which slide was removed. */
export interface PodsDeleteSlideResult extends PodsBridgeResult {
  /** The 1-based position that was deleted. */
  slideIndex: number;
  /** The reference of the removed slide. */
  removedRef: string;
  /** The number of slides before the delete. */
  slideCountBefore: number;
}

/** A dry-run result: the constructed revision with identity tokens, not written. */
export interface PodsDeleteSlideDryRun {
  dryRun: true;
  slideIndex: number;
  removedRef: string;
  slideCountBefore: number;
  rootObjectId: string;
  /** The ordered slide references, so the caller can confirm which slide index N addresses. */
  slideRefs: string[];
  /** The revision body with `__OTB_PODS_GUID__`/`__OTB_PODS_HEAD__` placeholders, for inspection/verification. */
  body: Record<string, unknown>;
}

/**
 * Resolve the live root and its slide list, construct the `DeleteSlide` revision for
 * the slide at the given 1-based index, and write it.
 */
export const runPodsDeleteSlide = async (
  params: PodsDeleteSlideParams,
): Promise<PodsDeleteSlideResult | PodsDeleteSlideDryRun> => {
  const guidToken = params.guidToken ?? DEFAULT_GUID_TOKEN;
  const headToken = params.headToken ?? DEFAULT_HEAD_TOKEN;
  const ctx = await resolveDeleteSlideContext(params);

  const slideCountBefore = ctx.slideRefs.length;
  if (params.slideIndex < 1 || params.slideIndex > slideCountBefore) {
    throw new FrameBridgeValidationError(
      `delete_slide index ${params.slideIndex} is out of range; the deck has ${slideCountBefore} slide(s).`,
    );
  }
  const removedRef = ctx.slideRefs[params.slideIndex - 1] ?? '';

  // The action id is per-call metadata, minted from a fresh guid (the guid token is
  // still an unsubstituted placeholder here, so it cannot seed it).
  const seed = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const actionDescriptorJson = JSON.stringify({
    ActionId: String((Number.parseInt(seed, 16) || 0) >>> 0),
    ActionName: 'DeleteSlide',
    ActionTime: String(Date.now()),
  });
  const body = buildDeleteSlideBody(ctx, params.slideIndex, guidToken, headToken, actionDescriptorJson);

  if (params.dryRun) {
    return {
      dryRun: true,
      slideIndex: params.slideIndex,
      removedRef,
      slideCountBefore,
      rootObjectId: ctx.rootObjectId,
      slideRefs: ctx.slideRefs,
      body,
    };
  }

  // Re-derive the revision on every attempt, and re-locate the slide by its
  // REFERENCE rather than its index: a retry follows a conflict, meaning the
  // document moved, and position 3 after a co-author's edit is not the slide the
  // caller asked to delete. Identity survives that; position does not.
  const nextContext = freshAfterFirst(ctx, () => resolveDeleteSlideContext(params));
  const bridgeParams: PodsBridgeParams = {
    tabId: params.tabId,
    frameUrlIncludes: params.frameUrlIncludes,
    donorGlobal: params.donorGlobal,
    headSentinel: params.headSentinel,
    body: async () => {
      const current = await nextContext();
      const index = current.slideRefs.indexOf(removedRef);
      if (index === -1) {
        throw new FrameBridgeValidationError(
          `Slide ${removedRef} is no longer in the deck — it was removed by someone else while this delete was in flight.`,
        );
      }
      return buildDeleteSlideBody(current, index + 1, guidToken, headToken, actionDescriptorJson);
    },
    guidToken,
    headToken,
  };
  // Confirm against the document rather than the response: the slide's reference
  // must be gone from the live slide list. A delete is not idempotent — retrying
  // one that already applied would remove a second slide — so an unconfirmed write
  // is reported, never re-issued.
  const result = await runPodsWriteConfirmed(bridgeParams, {
    readState: () => resolveDeleteSlideContext(params),
    isApplied: state => !state.slideRefs.includes(removedRef),
    idempotent: false,
  });

  return {
    ...result,
    slideIndex: params.slideIndex,
    removedRef,
    slideCountBefore,
  };
};
