/**
 * The pods live-model layer — one shared read of an open deck's object graph.
 *
 * Every pods operation (a formatting write, a structural write, an outline read)
 * starts the same way: read the LIVE document model in the editor frame and find
 * its target in it. The model is a type-2 poll from the zero base — the server
 * answers with the full current `RevisionList` (the load-time base plus every
 * co-authoring revision since), so it reflects edits made this session; the older
 * `openEarly` snapshot did not, and edits resolved against it landed on stale
 * object ids and never rendered.
 *
 * The read runs inside the editor OOPIF (`chrome.scripting.executeScript`, MAIN
 * world) because the endpoint is same-origin only to that frame and the session
 * headers live in the frame-local donor. The injected function is serialized by
 * Chrome, so it cannot close over module scope — which is why it is defined once
 * here and shared by every action, instead of being re-embedded per operation.
 * It walks the response latest-wins per object id (the way the editor applies
 * deltas onto its base), filters to the ClassIds the caller declared, and returns
 * a compact object index. Target resolution then happens in the service worker as
 * plain, testable code over that index.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { BRIDGE_REPLAY_DEPTH_GLOBAL, FORBIDDEN_REPLAY_HEADERS } from './frame-fetch.js';

/** One object of the live model: a `{ClassId, ObjectId, Properties}` triple, latest-wins. */
export interface PodsObject {
  classId: number;
  objectId: string;
  /** Flat `[id, value, id, value, …]` pair list, exactly as the wire carries it. */
  properties: (string | number)[];
}

/** The filtered live model plus honesty counts, so a partial view is never mistaken for the whole. */
export interface PodsModel {
  objects: PodsObject[];
  /** Objects in the live model before the class filter. */
  totalObjects: number;
}

/** Well-known pods ClassIds. */
export const CLASS_PRESENTATION = 393271;
export const CLASS_SLIDE = 393227;
export const CLASS_PARAGRAPH = 393230;
export const CLASS_RUN = 1179725;
export const CLASS_RENDER_SHAPE = 1074135132;

/** Well-known pods property ids. */
export const PROP_TEXT = 469769250;
export const PROP_RUN_REF = 603987475;
export const PROP_SLIDE_LIST = 603986975;
export const PROP_ACTION_CTX = 536889540;
export const PROP_SHAPE_NAME = 469780826;

/** How long to wait for the editor frame's donor to appear before failing the read. */
const DEFAULT_DONOR_WAIT_MS = 15_000;
/** How often to re-probe while waiting for the donor. */
const DONOR_POLL_INTERVAL_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** Read a property value from a flat `[id, value, …]` list. */
export const readProp = (properties: (string | number)[], id: number): string | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return String(properties[i + 1]);
  return undefined;
};

/** Parse a `{guid}{ctr},…` reference list into its individual `{guid}{ctr}` tokens. */
export const parseRefList = (value: string): string[] =>
  value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/** A `{guid}{ctr}` reference token → the `guid|ctr` object id it names, or null. */
export const refToObjectId = (token: string): string | null => {
  const m = token.match(/\{([0-9a-f-]+)\}\{(\d+)\}/i);
  return m ? `${m[1]}|${m[2]}` : null;
};

/** The guid half of a `guid|ctr` object id. */
export const guidOf = (objectId: string): string => objectId.split('|')[0] ?? objectId;

/** The presentation root (`ClassId 393271`), or a validation error naming what is missing. */
export const findPresentationRoot = (model: PodsModel): PodsObject => {
  const root = model.objects.find(o => o.classId === CLASS_PRESENTATION);
  if (!root) throw new FrameBridgeValidationError('Live model carried no presentation root (ClassId 393271).');
  return root;
};

/** The root's ordered slide reference list, or a validation error when the root lacks it. */
export const slideRefsOf = (root: PodsObject): { slideList: string; slideRefs: string[] } => {
  const slideList = readProp(root.properties, PROP_SLIDE_LIST);
  if (slideList === undefined) {
    throw new FrameBridgeValidationError('Presentation root has no slide-list property (603986975).');
  }
  return { slideList, slideRefs: parseRefList(slideList) };
};

/** The slide's storage cell id, derived from the presentation root (`<root guid>|3`). */
export const cellIdOf = (root: PodsObject): string => `${guidOf(root.objectId)}|3`;

/** The action-descriptor object id, derived from the root's action-context reference (`<guid>|1`). */
export const actionDescIdOf = (root: PodsObject): string => {
  const actionRef = readProp(root.properties, PROP_ACTION_CTX);
  const actionId = actionRef ? refToObjectId(actionRef) : null;
  if (!actionId) {
    throw new FrameBridgeValidationError('Presentation root has no action-context reference to derive the descriptor.');
  }
  return `${guidOf(actionId)}|1`;
};

/** The parameters every live-model read needs. */
export interface ReadPodsModelParams {
  tabId: number;
  /** Substring selecting the PowerPoint editor OOPIF (e.g. `powerpoint.officeapps.live.com`). */
  frameUrlIncludes: string;
  /** Frame global the pre-script stashes the freshest `/pods` request into. */
  donorGlobal: string;
  /** The `{Mode:4,srs:[[2,…]]}` type-2 zero-base poll body, sent as the read request body. */
  modelReadBody: string;
  /** ClassIds to keep in the returned index. The presentation root is always kept. */
  classFilter: number[];
  /** How long to wait for the donor to appear (default {@link DEFAULT_DONOR_WAIT_MS}; 0 = no wait). */
  donorWaitMs?: number;
}

/** In-frame result of the model read. */
type InFrameModelResult = { error: string } | { objects: PodsObject[]; totalObjects: number };

/**
 * Locate the editor frame that holds the donor.
 *
 * When the frame exists but has not captured a donor yet — a deck that opened
 * seconds ago and has not issued its first `/pods` request — this waits a bounded
 * time rather than failing instantly, since the donor is usually moments away. A
 * tab with no editor frame at all fails immediately: no amount of waiting makes a
 * frame appear inside a tool call (that is `open_in_editor`'s job). On timeout it
 * falls back to the first URL-matching frame so a genuinely absent donor still
 * surfaces the in-frame error message, which names the global and what to do.
 */
const findEditorFrame = async (
  tabId: number,
  frameUrlIncludes: string,
  donorGlobal: string,
  donorWaitMs: number,
): Promise<number> => {
  const deadline = Date.now() + donorWaitMs;
  for (;;) {
    const frameProbe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (donorName: string) => ({
        href: location.href,
        hasDonor: Boolean((globalThis as Record<string, unknown>)[donorName]),
      }),
      args: [donorGlobal],
    });
    const info = (frame: (typeof frameProbe)[number]): { href?: string; hasDonor?: boolean } =>
      (frame.result as { href?: string; hasDonor?: boolean } | undefined) ?? {};
    const urlMatches = frameProbe.filter(frame => info(frame).href?.includes(frameUrlIncludes));
    const withDonor = urlMatches.find(frame => info(frame).hasDonor) ?? frameProbe.find(frame => info(frame).hasDonor);
    if (withDonor?.frameId !== undefined) return withDonor.frameId;

    if (urlMatches.length === 0) {
      throw new FrameBridgeValidationError(
        `No editor frame in tab ${tabId} with a URL containing "${frameUrlIncludes}". ` +
          'Open the deck in the PowerPoint web editor (or use open_in_editor), then retry.',
      );
    }
    if (Date.now() >= deadline) {
      const fallback = urlMatches[0];
      if (fallback?.frameId !== undefined) return fallback.frameId;
      throw new FrameBridgeValidationError(
        `No editor frame in tab ${tabId} with a URL containing "${frameUrlIncludes}".`,
      );
    }
    await delay(DONOR_POLL_INTERVAL_MS);
  }
};

/**
 * Read the live model in the editor frame and return the filtered object index.
 *
 * The multi-megabyte response is fetched, parsed, walked, and discarded inside the
 * frame; only the filtered `{classId, objectId, properties}` triples cross the
 * process boundary. Throws {@link FrameBridgeValidationError} with an actionable
 * message when the frame, donor, or model is not available.
 */
export const readPodsModel = async (params: ReadPodsModelParams): Promise<PodsModel> => {
  const frameId = await findEditorFrame(
    params.tabId,
    params.frameUrlIncludes,
    params.donorGlobal,
    params.donorWaitMs ?? DEFAULT_DONOR_WAIT_MS,
  );

  const keepClasses = [...new Set([CLASS_PRESENTATION, ...params.classFilter])];
  const results = await chrome.scripting.executeScript({
    target: { tabId: params.tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: async (
      donorName: string,
      modelReadBody: string,
      depthGlobal: string,
      forbidden: string[],
      keep: number[],
    ): Promise<InFrameModelResult> => {
      const donor = (globalThis as Record<string, unknown>)[donorName] as
        | { url?: string; headers?: Record<string, string> }
        | undefined;
      if (!donor || typeof donor.url !== 'string') {
        return {
          error: `No donor request is stashed under "${donorName}". Open and activate the deck so the editor polls, then retry.`,
        };
      }

      const forbiddenSet = new Set(forbidden);
      const headers: Record<string, string> = {};
      if (donor.headers && typeof donor.headers === 'object') {
        for (const [name, value] of Object.entries(donor.headers)) {
          // Strip any leftover `postdata` header: the model-read payload rides in
          // the request body here, and a stale postdata header would override it.
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
          // A type-2 poll from the zero base: the server returns the full current
          // RevisionList (the load base plus every co-authoring revision since), so
          // the model reflects live edits — unlike the frozen openEarly snapshot.
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

      // Walk the RevisionList in document order (oldest revision first), collecting
      // every {ClassId, ObjectId, Properties}. The same object id recurs across the
      // revisions that touched it; keeping the LAST occurrence per id (Map.set
      // overwrites) rebuilds the current document latest-wins — the way the editor
      // applies the deltas onto its base.
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

      const keepSet = new Set(keep);
      const objects = [...byId.values()].filter(o => keepSet.has(o.classId));
      return { objects, totalObjects: byId.size };
    },
    args: [
      params.donorGlobal,
      params.modelReadBody,
      BRIDGE_REPLAY_DEPTH_GLOBAL,
      [...FORBIDDEN_REPLAY_HEADERS],
      keepClasses,
    ],
  });

  const result = results[0]?.result as InFrameModelResult | undefined;
  if (!result) throw new FrameBridgeValidationError(`Live-model read returned no result for tab ${params.tabId}.`);
  if ('error' in result) throw new FrameBridgeValidationError(result.error);
  return { objects: result.objects, totalObjects: result.totalObjects };
};
