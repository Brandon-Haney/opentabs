/**
 * Pods `set_font_size` engine — resolve a run by visible text, then resize it.
 *
 * Changing the font size of text in an OPEN deck is a co-authoring revision, so it
 * rides the same `/pods/PowerPoint.ashx` channel as {@link runPodsBridge}. What is
 * different is that the revision must name live, per-session object ids (the
 * paragraph, its run, the slide's storage cell) that only exist in the running
 * editor. This engine reads them on demand:
 *
 *  1. In the editor frame, replay the editor's own full-model load
 *     (`?openEarly=true`, the `{Mode:4,srs:[[1,{SlideID}]]}` payload in a `postdata`
 *     header, session creds from the frame-local donor). It returns the whole slide
 *     object graph — a type-1 response with `BaseId 00000000-…|0`.
 *  2. Parse that graph *inside the frame* and return only the target paragraph and
 *     its run, so a ~450 KB model never crosses the process boundary (it would be
 *     cut at {@link MAX_FRAME_FETCH_RESPONSE} and fail to parse).
 *  3. In the service worker, build the type-1 write body — a copy of the run with
 *     `268442635` (font size, half-points) changed, the paragraph with its run-ref
 *     rewritten to point at the new run, and a `SetFontSize` action descriptor —
 *     with identity placeholders, and hand it to {@link runPodsBridge} for the
 *     head read, GUID mint, substitution, POST, and conflict retry.
 *
 * The read is non-mutating and needs no page reload: the editor streams the model
 * over pods on every session, so replaying that load fetches it again live.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { BRIDGE_REPLAY_DEPTH_GLOBAL, FORBIDDEN_REPLAY_HEADERS } from './frame-fetch.js';
import { type PodsBridgeParams, type PodsBridgeResult, runPodsBridge } from './pods-bridge.js';

/** Pods ClassIds the resolver keys on. */
const CLASS_PRESENTATION = 393271;
const CLASS_PARAGRAPH = 393230;
const CLASS_RUN = 1179725;
/** Pods property ids: paragraph text, paragraph run-reference list, run font size (half-points), presentation's action-context reference. */
const PROP_TEXT = 469769250;
const PROP_RUN_REF = 603987475;
const PROP_FONT_SIZE = 268442635;
const PROP_ACTION_CTX = 536889540;

const DEFAULT_GUID_TOKEN = '__OTB_PODS_GUID__';
const DEFAULT_HEAD_TOKEN = '__OTB_PODS_HEAD__';

/** Directive parameters for a `set_font_size` write, validated in `tool-dispatch`. */
export interface PodsSetFontSizeParams {
  tabId: number;
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  /** Exact visible text of the target paragraph (matched against `PROP_TEXT`). */
  text: string;
  /** New font size in points. */
  sizePt: number;
  /** The `{Mode:4,srs:[[1,…]]}` full-model request payload, carried in the `postdata` header. */
  openEarlyPostdata: string;
  guidToken?: string;
  headToken?: string;
}

/** One text run a paragraph references, resolved from the model. */
interface ResolvedRun {
  /** The raw `{guid}{ctr}` reference token as it appears in the paragraph's run-ref list. */
  ref: string;
  objectId: string;
  properties: (string | number)[];
  sizeHalfPt: string | null;
}

/** The live objects a `set_font_size` write needs, read from the editor's model. */
export interface ResolvedTarget {
  /** The slide's storage cell id (`<presentation-root guid>|3`). */
  cellId: string;
  /** The `SetFontSize` action descriptor id (`<presentation action-context guid>|1`). */
  actionDescId: string;
  paragraphId: string;
  paragraphProperties: (string | number)[];
  /** The paragraph's raw run-reference list value (`{guid}{ctr},…`). */
  runRef: string;
  /** The text runs the paragraph references, in order. */
  textRuns: ResolvedRun[];
}

/**
 * Sort a flat `[id, value, id, value, …]` property list ascending by id.
 *
 * The one write proven to apply cleanly emitted paragraph and run properties in
 * strictly-ascending id order, whereas the model's own read returns them
 * unsorted. `Properties` deserializes to a keyed id→value map so order is very
 * likely irrelevant, but matching the proven serialization removes the only
 * variable a live write has not yet exercised, at no cost.
 */
const sortPropertiesById = (properties: (string | number)[]): (string | number)[] => {
  const pairs: [string | number, string | number][] = [];
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key !== undefined && value !== undefined) pairs.push([key, value]);
  }
  pairs.sort((a, b) => Number(a[0]) - Number(b[0]));
  return pairs.flat();
};

/**
 * Build the type-1 `set_font_size` revision body with identity placeholders.
 *
 * Pure and deterministic so it can be unit-tested against a captured, proven write.
 * The new run copies the target run's properties verbatim (font, colour, weight,
 * and its references to existing style objects) with only the size changed, so no
 * formatting is lost; the paragraph is resubmitted with its run-reference rewritten
 * to swap the old run for `{GUID}{1}`, so the run is not orphaned.
 */
export const buildSetFontSizeBody = (
  target: ResolvedTarget,
  newSizeHalfPt: number,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => {
  const [run, ...extraRuns] = target.textRuns;
  if (!run || extraRuns.length > 0) {
    throw new FrameBridgeValidationError(
      `set_font_size resizes single-run text; "${target.paragraphId}" has ${target.textRuns.length} formatting runs. ` +
        'Resizing multi-run text is not supported yet.',
    );
  }

  const newRunProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < run.properties.length; i += 2) {
    const key = run.properties[i];
    const value = run.properties[i + 1];
    if (key === undefined || value === undefined) continue;
    newRunProperties.push(key, key === PROP_FONT_SIZE ? String(newSizeHalfPt) : value);
  }

  const rewrittenRef = target.runRef
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(ref => (ref === run.ref ? `{${guidToken}}{1}` : ref))
    .join(',');
  const newParagraphProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < target.paragraphProperties.length; i += 2) {
    const key = target.paragraphProperties[i];
    const value = target.paragraphProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    newParagraphProperties.push(key, key === PROP_RUN_REF ? rewrittenRef : value);
  }

  const objects = [
    {
      ObjectId: target.actionDescId,
      ClassId: 131140,
      Properties: [134236193, 'true', 335562934, '1', 469780989, 'SetFontSize'],
    },
    { ObjectId: target.paragraphId, ClassId: CLASS_PARAGRAPH, Properties: sortPropertiesById(newParagraphProperties) },
    { ObjectId: `${guidToken}|1`, ClassId: CLASS_RUN, Properties: sortPropertiesById(newRunProperties) },
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
          Sequence: 29,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

/** In-frame result: either an error string or the resolved target. */
type ResolveResult = { error: string } | { target: ResolvedTarget };

/**
 * Replay the editor's full-model load in the editor frame and resolve the target
 * paragraph and its runs, returning only that small slice. Everything runs in the
 * frame's MAIN world so the request is same-origin and the multi-megabyte model is
 * parsed and discarded there.
 */
const resolvePodsTarget = async (params: PodsSetFontSizeParams): Promise<ResolvedTarget> => {
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
      postdata: string,
      targetText: string,
      depthGlobal: string,
      forbidden: string[],
      classPresentation: number,
      classParagraph: number,
      classRun: number,
      propText: number,
      propRunRef: number,
      propFontSize: number,
      propActionCtx: number,
    ): Promise<ResolveResult> => {
      const donor = (globalThis as Record<string, unknown>)[donorName] as
        | { url?: string; headers?: Record<string, string> }
        | undefined;
      if (!donor || typeof donor.url !== 'string') {
        return {
          error: `No donor request is stashed under "${donorName}". Open and activate the deck so the editor polls, then retry.`,
        };
      }

      let openEarlyUrl: string;
      try {
        const parsed = new URL(donor.url);
        parsed.search = '?openEarly=true';
        openEarlyUrl = parsed.href;
      } catch {
        return { error: `Donor URL is not absolute: ${String(donor.url).slice(0, 120)}` };
      }

      const forbiddenSet = new Set(forbidden);
      const headers: Record<string, string> = {};
      if (donor.headers && typeof donor.headers === 'object') {
        for (const [name, value] of Object.entries(donor.headers)) {
          if (typeof value === 'string' && !forbiddenSet.has(name.toLowerCase())) headers[name] = value;
        }
      }
      headers.postdata = postdata;

      const scope = globalThis as unknown as Record<string, number | undefined>;
      let text: string;
      try {
        scope[depthGlobal] = (scope[depthGlobal] ?? 0) + 1;
        let response: Response;
        try {
          response = await fetch(openEarlyUrl, { method: 'POST', headers, credentials: 'include', body: '' });
        } finally {
          scope[depthGlobal] = (scope[depthGlobal] ?? 1) - 1;
        }
        text = await response.text();
      } catch (err) {
        return { error: `Full-model read failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      let root: unknown;
      try {
        root = JSON.parse(text);
      } catch {
        return { error: `Full-model response was not JSON: ${text.slice(0, 120)}` };
      }

      // Collect every {ClassId, ObjectId, Properties} object across the whole graph.
      const objects: { classId: number; objectId: string; properties: (string | number)[] }[] = [];
      const stack: unknown[] = [root];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) {
          for (const child of node) stack.push(child);
          continue;
        }
        if (node && typeof node === 'object') {
          const obj = node as Record<string, unknown>;
          if (typeof obj.ClassId === 'number' && typeof obj.ObjectId === 'string' && Array.isArray(obj.Properties)) {
            objects.push({
              classId: obj.ClassId,
              objectId: obj.ObjectId,
              properties: obj.Properties as (string | number)[],
            });
          }
          for (const value of Object.values(obj)) {
            if (value && typeof value === 'object') stack.push(value);
          }
        }
      }

      const byId = new Map(objects.map(o => [o.objectId, o]));
      const prop = (properties: (string | number)[], id: number): string | undefined => {
        for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return String(properties[i + 1]);
        return undefined;
      };
      const guidOf = (objectId: string): string => objectId.split('|')[0] ?? objectId;
      const refToId = (token: string): string | null => {
        const m = token.match(/\{([0-9a-f-]+)\}\{(\d+)\}/i);
        return m ? `${m[1]}|${m[2]}` : null;
      };

      const presentation = objects.find(o => o.classId === classPresentation);
      if (!presentation) return { error: 'Full-model response carried no presentation root (ClassId 393271).' };
      const cellId = `${guidOf(presentation.objectId)}|3`;
      const actionRef = prop(presentation.properties, propActionCtx);
      const actionGuidId = actionRef ? refToId(actionRef) : null;
      if (!actionGuidId)
        return { error: 'Presentation root has no action-context reference to derive the descriptor.' };
      const actionDescId = `${guidOf(actionGuidId)}|1`;

      const paragraph = objects.find(o => o.classId === classParagraph && prop(o.properties, propText) === targetText);
      if (!paragraph) {
        const samples = objects
          .filter(o => o.classId === classParagraph)
          .map(o => prop(o.properties, propText))
          .filter((t): t is string => Boolean(t))
          .slice(0, 12);
        return {
          error: `No text on the slide exactly matches "${targetText}". Nearby text: ${samples.map(t => `"${t}"`).join(', ')}`,
        };
      }

      const runRef = prop(paragraph.properties, propRunRef) ?? '';
      const textRuns: ResolvedRun[] = [];
      for (const part of runRef
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)) {
        const id = refToId(part);
        const run = id ? byId.get(id) : undefined;
        if (run && run.classId === classRun) {
          textRuns.push({
            ref: part,
            objectId: run.objectId,
            properties: run.properties,
            sizeHalfPt: prop(run.properties, propFontSize) ?? null,
          });
        }
      }

      return {
        target: {
          cellId,
          actionDescId,
          paragraphId: paragraph.objectId,
          paragraphProperties: paragraph.properties,
          runRef,
          textRuns,
        },
      };
    },
    args: [
      params.donorGlobal,
      params.openEarlyPostdata,
      params.text,
      BRIDGE_REPLAY_DEPTH_GLOBAL,
      [...FORBIDDEN_REPLAY_HEADERS],
      CLASS_PRESENTATION,
      CLASS_PARAGRAPH,
      CLASS_RUN,
      PROP_TEXT,
      PROP_RUN_REF,
      PROP_FONT_SIZE,
      PROP_ACTION_CTX,
    ],
  });

  const result = results[0]?.result as ResolveResult | undefined;
  if (!result) throw new FrameBridgeValidationError(`Full-model resolve returned no result for tab ${params.tabId}.`);
  if ('error' in result) throw new FrameBridgeValidationError(result.error);
  return result.target;
};

/** What `set_font_size` returns: the write result plus the before/after size for confirmation. */
export interface PodsSetFontSizeResult extends PodsBridgeResult {
  text: string;
  runId: string;
  oldSizePt: number | null;
  newSizePt: number;
}

/**
 * Resolve the target run, build the resize revision, and write it. `sizePt` is
 * converted to the half-point unit the wire uses; the before size is read off the
 * resolved run so the result reports the change without a second read.
 */
export const runPodsSetFontSize = async (params: PodsSetFontSizeParams): Promise<PodsSetFontSizeResult> => {
  const guidToken = params.guidToken ?? DEFAULT_GUID_TOKEN;
  const headToken = params.headToken ?? DEFAULT_HEAD_TOKEN;
  const target = await resolvePodsTarget(params);

  const newSizeHalfPt = Math.round(params.sizePt * 2);
  const body = buildSetFontSizeBody(target, newSizeHalfPt, guidToken, headToken);

  const bridgeParams: PodsBridgeParams = {
    tabId: params.tabId,
    frameUrlIncludes: params.frameUrlIncludes,
    donorGlobal: params.donorGlobal,
    headSentinel: params.headSentinel,
    body,
    guidToken,
    headToken,
  };
  const result = await runPodsBridge(bridgeParams);

  const oldHalfPt = target.textRuns[0]?.sizeHalfPt;
  return {
    ...result,
    text: params.text,
    runId: target.textRuns[0]?.objectId ?? '',
    oldSizePt: oldHalfPt ? Number(oldHalfPt) / 2 : null,
    newSizePt: params.sizePt,
  };
};
