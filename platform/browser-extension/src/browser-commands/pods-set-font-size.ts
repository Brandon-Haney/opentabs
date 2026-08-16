/**
 * Pods `set_font_size` engine — resolve a run by visible text, then resize it.
 *
 * Changing the font size of text in an OPEN deck is a co-authoring revision, so it
 * rides the same `/pods/PowerPoint.ashx` channel as {@link runPodsBridge}. What is
 * different is that the revision must name live, per-session object ids (the
 * paragraph, its run, the slide's storage cell) that only exist in the running
 * editor. This engine reads them on demand:
 *
 *  1. In the editor frame, read the LIVE model: a type-2 poll from the zero base
 *     (session creds from the frame-local donor) returns the full current
 *     RevisionList — the load base plus every co-authoring revision since. This
 *     reflects edits already made this session; the older `openEarly` snapshot did
 *     not, so edits resolved against it landed on stale object ids and never
 *     rendered.
 *  2. Rebuild the current document latest-wins per object id and resolve the target
 *     *inside the frame*, returning only the target paragraph and its run, so a
 *     multi-megabyte model never crosses the process boundary (it would be cut at
 *     {@link MAX_FRAME_FETCH_RESPONSE} and fail to parse).
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
import {
  freshAfterFirst,
  type PodsBridgeParams,
  type PodsBridgeResult,
  runPodsWriteConfirmed,
  sortPropertiesById,
} from './pods-bridge.js';

/** Pods ClassIds the resolver keys on. */
const CLASS_PRESENTATION = 393271;
const CLASS_PARAGRAPH = 393230;
const CLASS_RUN = 1179725;
/** Pods property ids: paragraph text, paragraph run-reference list, presentation's action-context reference. */
const PROP_TEXT = 469769250;
const PROP_RUN_REF = 603987475;
const PROP_ACTION_CTX = 536889540;
/** Run (1179725) format property ids, decoded from captured SetFontSize/Bold/SetItalic/Font/SetFontColor writes. */
const PROP_FONT_SIZE = 268442635;
const PROP_BOLD = 134224900;
const PROP_ITALIC = 134224901;
const PROP_UNDERLINE = 134224902;
/** Font colour: a display string `@RRGGBB,,` and its BGR-integer mirror, always written together. */
const PROP_COLOR_STR = 469780760;
const PROP_COLOR_BGR = 335551500;
/** Font family: the typeface name is written to all four face slots (typeface, latin, EA, CS). */
const PROP_FONT_FACES = [469769226, 469780527, 469780528, 469780529];

/**
 * The run-level format changes a single `format_text` write can apply. Only the
 * keys that are set change; the rest of the run is copied through untouched.
 * Bold/italic/underline are the `true`/`false` string flags the run carries; size
 * is in half-points; `colorHex` is 6-digit `RRGGBB`; `font` is a family name.
 */
export interface RunFormatChanges {
  sizeHalfPt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  colorHex?: string;
  font?: string;
}

/** `RRGGBB` → the BGR integer PowerPoint stores alongside the `@RRGGBB,,` display colour. */
const hexToBgrInt = (hex: string): number => {
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return (b << 16) | (g << 8) | r;
};

/**
 * The new wire value for a run property under the requested changes, or undefined
 * when this change set does not touch that property. One place maps a property id
 * to its override so the copy loop and the append pass agree. Colour and font each
 * span several properties that all derive from a single requested value.
 */
const overrideForRunProp = (propId: number, changes: RunFormatChanges): string | undefined => {
  if (propId === PROP_FONT_SIZE && changes.sizeHalfPt !== undefined) return String(changes.sizeHalfPt);
  if (propId === PROP_BOLD && changes.bold !== undefined) return changes.bold ? 'true' : 'false';
  if (propId === PROP_ITALIC && changes.italic !== undefined) return changes.italic ? 'true' : 'false';
  if (propId === PROP_UNDERLINE && changes.underline !== undefined) return changes.underline ? 'true' : 'false';
  if (propId === PROP_COLOR_STR && changes.colorHex !== undefined) return `@${changes.colorHex},,`;
  if (propId === PROP_COLOR_BGR && changes.colorHex !== undefined) return String(hexToBgrInt(changes.colorHex));
  if (PROP_FONT_FACES.includes(propId) && changes.font !== undefined) return changes.font;
  return undefined;
};

/** Read a run property's current wire value from a flat `[id, value, …]` list. */
const readRunProp = (properties: (string | number)[], id: number): string | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return String(properties[i + 1]);
  return undefined;
};

/** The run property ids a change set targets — used to append any the run does not already carry. */
const requestedRunProps = (changes: RunFormatChanges): number[] => {
  const ids: number[] = [];
  if (changes.sizeHalfPt !== undefined) ids.push(PROP_FONT_SIZE);
  if (changes.bold !== undefined) ids.push(PROP_BOLD);
  if (changes.italic !== undefined) ids.push(PROP_ITALIC);
  if (changes.underline !== undefined) ids.push(PROP_UNDERLINE);
  if (changes.colorHex !== undefined) ids.push(PROP_COLOR_STR, PROP_COLOR_BGR);
  if (changes.font !== undefined) ids.push(...PROP_FONT_FACES);
  return ids;
};

/**
 * True when a run already carries every property value a change set asked for —
 * the post-write check that the format actually landed on the document, rather
 * than merely being accepted by the server.
 */
const runReflectsChanges = (run: ResolvedRun, changes: RunFormatChanges): boolean =>
  requestedRunProps(changes).every(propId => {
    const expected = overrideForRunProp(propId, changes);
    return expected === undefined || readRunProp(run.properties, propId) === expected;
  });

const DEFAULT_GUID_TOKEN = '__OTB_PODS_GUID__';
const DEFAULT_HEAD_TOKEN = '__OTB_PODS_HEAD__';

/** The inputs every run-level pods edit needs to locate its target in the live model. */
export interface PodsResolveParams {
  tabId: number;
  frameUrlIncludes: string;
  donorGlobal: string;
  /** Exact visible text of the target paragraph (matched against `PROP_TEXT`). */
  text: string;
  /** The `{Mode:4,srs:[[2,…]]}` live-model poll body (type-2, zero base), sent as the read request body. */
  modelReadBody: string;
}

/** Directive parameters for a `set_font_size` write, validated in `tool-dispatch`. */
export interface PodsSetFontSizeParams extends PodsResolveParams {
  headSentinel: string;
  /** New font size in points. */
  sizePt: number;
  guidToken?: string;
  headToken?: string;
}

/** Directive parameters for a `format_text` write, validated in `tool-dispatch`. */
export interface PodsFormatTextParams extends PodsResolveParams {
  headSentinel: string;
  /** New size in points, if changing size. */
  sizePt?: number;
  /** New bold state, if changing bold. */
  bold?: boolean;
  /** New italic state, if changing italic. */
  italic?: boolean;
  /** New underline state, if changing underline. */
  underline?: boolean;
  /** New font colour as 6-digit hex `RRGGBB`, if changing colour. */
  colorHex?: string;
  /** New font family name, if changing font. */
  font?: string;
  guidToken?: string;
  headToken?: string;
}

/** One text run a paragraph references, resolved from the model. */
interface ResolvedRun {
  /** The raw `{guid}{ctr}` reference token as it appears in the paragraph's run-ref list. */
  ref: string;
  objectId: string;
  properties: (string | number)[];
  /** The run's current formatting, read for before/after reporting. Strings as they appear on the wire. */
  sizeHalfPt: string | null;
  bold: string | null;
  italic: string | null;
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
 * Build the type-3 run-format revision body with identity placeholders.
 *
 * Generalizes the proven `SetFontSize` write: the revision is really "merge this
 * modified copy of the run into its paragraph", so the same shape applies any run
 * property change, not just size. The new run copies the target run's properties
 * verbatim (font, colour, weight, and its references to existing style objects),
 * overriding only the properties named in `changes` — and appending any the run
 * did not already carry (e.g. a bold flag on a run that had never been bolded), so
 * turning a format on works even from a default run. The paragraph is resubmitted
 * with its run-reference rewritten to swap the old run for `{GUID}{1}`, so the run
 * is not orphaned. Pure and deterministic, for unit testing against a captured write.
 */
export const buildRunFormatBody = (
  target: ResolvedTarget,
  changes: RunFormatChanges,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => {
  const [run, ...extraRuns] = target.textRuns;
  if (!run || extraRuns.length > 0) {
    throw new FrameBridgeValidationError(
      `format_text formats single-run text; "${target.paragraphId}" has ${target.textRuns.length} formatting runs. ` +
        'Formatting multi-run text is not supported yet.',
    );
  }
  const requested = requestedRunProps(changes);
  if (requested.length === 0) {
    throw new FrameBridgeValidationError(
      'format_text needs at least one property to change (size, bold, italic, underline, color, or font).',
    );
  }

  const seen = new Set<number>();
  const newRunProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < run.properties.length; i += 2) {
    const key = run.properties[i];
    const value = run.properties[i + 1];
    if (key === undefined || value === undefined) continue;
    const override = typeof key === 'number' ? overrideForRunProp(key, changes) : undefined;
    if (typeof key === 'number') seen.add(key);
    newRunProperties.push(key, override ?? value);
  }
  // Add any requested property the run did not already carry, so a format can be
  // turned on from a run that never had that property set.
  for (const propId of requested) {
    if (seen.has(propId)) continue;
    const value = overrideForRunProp(propId, changes);
    if (value !== undefined) newRunProperties.push(propId, value);
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

/** Size-only run-format build — the original `set_font_size` write, now a thin wrapper. */
export const buildSetFontSizeBody = (
  target: ResolvedTarget,
  newSizeHalfPt: number,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => buildRunFormatBody(target, { sizeHalfPt: newSizeHalfPt }, guidToken, headToken);

/** In-frame result: either an error string or the resolved target. */
type ResolveResult = { error: string } | { target: ResolvedTarget };

/**
 * Read the LIVE model in the editor frame and resolve the target paragraph and its
 * runs, returning only that small slice. Runs a type-2 poll from the zero base
 * (`modelReadBody`) so the model includes every co-authoring revision, then rebuilds
 * the current document latest-wins per object id. Everything runs in the frame's
 * MAIN world so the request is same-origin and the multi-megabyte model is parsed
 * and discarded there.
 */
const resolvePodsTarget = async (params: PodsResolveParams): Promise<ResolvedTarget> => {
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
      propBold: number,
      propItalic: number,
    ): Promise<ResolveResult> => {
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
      const objects = [...byId.values()];
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
            bold: prop(run.properties, propBold) ?? null,
            italic: prop(run.properties, propItalic) ?? null,
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
      params.modelReadBody,
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
      PROP_BOLD,
      PROP_ITALIC,
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

  // Re-resolve the target on every attempt: the revision names a specific run
  // object, and a retry follows a conflict, by which point that run may have been
  // replaced. Resolving by the paragraph's visible text re-finds it either way.
  const nextTarget = freshAfterFirst(target, () => resolvePodsTarget(params));
  const bridgeParams: PodsBridgeParams = {
    tabId: params.tabId,
    frameUrlIncludes: params.frameUrlIncludes,
    donorGlobal: params.donorGlobal,
    headSentinel: params.headSentinel,
    body: async () => buildSetFontSizeBody(await nextTarget(), newSizeHalfPt, guidToken, headToken),
    guidToken,
    headToken,
  };
  // Confirm against the document: the run must actually carry the new size. A
  // resize is idempotent, so an unconfirmed write is safely re-issued.
  const result = await runPodsWriteConfirmed(bridgeParams, {
    readState: () => resolvePodsTarget(params),
    isApplied: state => state.textRuns[0]?.sizeHalfPt === String(newSizeHalfPt),
    idempotent: true,
  });

  const oldHalfPt = target.textRuns[0]?.sizeHalfPt;
  return {
    ...result,
    text: params.text,
    runId: target.textRuns[0]?.objectId ?? '',
    oldSizePt: oldHalfPt ? Number(oldHalfPt) / 2 : null,
    newSizePt: params.sizePt,
  };
};

/** What `format_text` returns: the write result, the run's prior formatting, and what was requested. */
export interface PodsFormatTextResult extends PodsBridgeResult {
  text: string;
  runId: string;
  /** The run's formatting before the write (null where the run carried no such property). */
  before: { sizePt: number | null; bold: boolean | null; italic: boolean | null };
  /**
   * The changes that were asked for, echoed back. This is the request, not proof of
   * the outcome — `applied` (from {@link PodsBridgeResult}) is what says whether the
   * document actually changed.
   */
  requested: {
    sizePt?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    colorHex?: string;
    font?: string;
  };
}

/** Parse a run's `"true"`/`"false"` flag string to a boolean, or null when the property was absent. */
const flagToBool = (value: string | null): boolean | null => (value === null ? null : value === 'true');

/**
 * Resolve the target run, build a run-format revision from the requested changes,
 * and write it. Reports the run's prior formatting (read off the resolved run) so
 * the caller sees the before/after without a second read.
 */
export const runPodsFormatText = async (params: PodsFormatTextParams): Promise<PodsFormatTextResult> => {
  const guidToken = params.guidToken ?? DEFAULT_GUID_TOKEN;
  const headToken = params.headToken ?? DEFAULT_HEAD_TOKEN;
  const target = await resolvePodsTarget(params);

  const changes: RunFormatChanges = {
    ...(params.sizePt !== undefined ? { sizeHalfPt: Math.round(params.sizePt * 2) } : {}),
    ...(params.bold !== undefined ? { bold: params.bold } : {}),
    ...(params.italic !== undefined ? { italic: params.italic } : {}),
    ...(params.underline !== undefined ? { underline: params.underline } : {}),
    ...(params.colorHex !== undefined ? { colorHex: params.colorHex } : {}),
    ...(params.font !== undefined ? { font: params.font } : {}),
  };
  // Re-resolve the target on every attempt, for the reason given in
  // `runPodsSetFontSize`: the revision names a run object that a conflicting edit
  // may already have replaced.
  const nextTarget = freshAfterFirst(target, () => resolvePodsTarget(params));
  const bridgeParams: PodsBridgeParams = {
    tabId: params.tabId,
    frameUrlIncludes: params.frameUrlIncludes,
    donorGlobal: params.donorGlobal,
    headSentinel: params.headSentinel,
    body: async () => buildRunFormatBody(await nextTarget(), changes, guidToken, headToken),
    guidToken,
    headToken,
  };
  // Confirm against the document: the run must carry every requested property.
  // Formatting is idempotent, so an unconfirmed write is safely re-issued.
  const result = await runPodsWriteConfirmed(bridgeParams, {
    readState: () => resolvePodsTarget(params),
    isApplied: state => {
      const written = state.textRuns[0];
      return written !== undefined && runReflectsChanges(written, changes);
    },
    idempotent: true,
  });

  const run = target.textRuns[0];
  return {
    ...result,
    text: params.text,
    runId: run?.objectId ?? '',
    before: {
      sizePt: run?.sizeHalfPt ? Number(run.sizeHalfPt) / 2 : null,
      bold: flagToBool(run?.bold ?? null),
      italic: flagToBool(run?.italic ?? null),
    },
    requested: {
      ...(params.sizePt !== undefined ? { sizePt: params.sizePt } : {}),
      ...(params.bold !== undefined ? { bold: params.bold } : {}),
      ...(params.italic !== undefined ? { italic: params.italic } : {}),
      ...(params.underline !== undefined ? { underline: params.underline } : {}),
      ...(params.colorHex !== undefined ? { colorHex: params.colorHex } : {}),
      ...(params.font !== undefined ? { font: params.font } : {}),
    },
  };
};
