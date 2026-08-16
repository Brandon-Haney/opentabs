/**
 * Pods run-format actions — `format_text` and its size-only wrapper `set_font_size`.
 *
 * Changing text formatting in an OPEN deck is a co-authoring revision: a copy of
 * the target run with the changed properties, plus the paragraph resubmitted with
 * its run-reference rewritten to the new run so it is not orphaned. The revision
 * shape was proven live as `SetFontSize` and generalizes to any run property — the
 * `ActionName` is cosmetic; the server applies the object-graph diff regardless.
 *
 * Property ids decoded from captured SetFontSize/Bold/SetItalic/Font/SetFontColor
 * writes; see `plugins/powerpoint/docs/pods-action-catalog.md`.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  actionDescIdOf,
  CLASS_PARAGRAPH,
  CLASS_RUN,
  cellIdOf,
  findPresentationRoot,
  type PodsModel,
  PROP_RUN_REF,
  PROP_TEXT,
  parseRefList,
  readProp,
  refToObjectId,
} from './pods-model.js';

/** Run (1179725) format property ids. */
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
 * The run-level format changes a single write can apply. Only the keys that are
 * set change; the rest of the run is copied through untouched. Bold/italic/
 * underline are the `true`/`false` string flags the run carries; size is in
 * half-points; `colorHex` is 6-digit `RRGGBB`; `font` is a family name.
 */
export interface RunFormatChanges {
  sizeHalfPt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  colorHex?: string;
  font?: string;
}

/** The validated arguments of a `format_text` action. */
export interface RunFormatArgs {
  /** Exact visible text of the target paragraph. */
  text: string;
  changes: RunFormatChanges;
  /** The size in points as requested, kept for result reporting. */
  requested: {
    sizePt?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    colorHex?: string;
    font?: string;
  };
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

/** One text run a paragraph references, resolved from the model. */
export interface ResolvedRun {
  /** The raw `{guid}{ctr}` reference token as it appears in the paragraph's run-ref list. */
  ref: string;
  objectId: string;
  properties: (string | number)[];
  /** The run's current formatting, read for before/after reporting. Strings as they appear on the wire. */
  sizeHalfPt: string | null;
  bold: string | null;
  italic: string | null;
}

/** The live objects a run-format write needs, resolved from the model. */
export interface ResolvedTarget {
  /** The slide's storage cell id (`<presentation-root guid>|3`). */
  cellId: string;
  /** The action descriptor id (`<presentation action-context guid>|1`). */
  actionDescId: string;
  paragraphId: string;
  paragraphProperties: (string | number)[];
  /** The paragraph's raw run-reference list value (`{guid}{ctr},…`). */
  runRef: string;
  /** The text runs the paragraph references, in order. */
  textRuns: ResolvedRun[];
}

/**
 * Find the paragraph whose visible text matches exactly, and its runs. Errors name
 * nearby text so a near-miss is a one-step fix rather than a guessing game.
 */
export const resolveRunFormatTarget = (model: PodsModel, text: string): ResolvedTarget => {
  const root = findPresentationRoot(model);
  const byId = new Map(model.objects.map(o => [o.objectId, o]));

  const paragraph = model.objects.find(
    o => o.classId === CLASS_PARAGRAPH && readProp(o.properties, PROP_TEXT) === text,
  );
  if (!paragraph) {
    const samples = model.objects
      .filter(o => o.classId === CLASS_PARAGRAPH)
      .map(o => readProp(o.properties, PROP_TEXT))
      .filter((t): t is string => Boolean(t))
      .slice(0, 12);
    throw new FrameBridgeValidationError(
      `No text on the slide exactly matches "${text}". Nearby text: ${samples.map(t => `"${t}"`).join(', ')}`,
    );
  }

  const runRef = readProp(paragraph.properties, PROP_RUN_REF) ?? '';
  const textRuns: ResolvedRun[] = [];
  for (const part of parseRefList(runRef)) {
    const id = refToObjectId(part);
    const run = id ? byId.get(id) : undefined;
    if (run && run.classId === CLASS_RUN) {
      textRuns.push({
        ref: part,
        objectId: run.objectId,
        properties: run.properties,
        sizeHalfPt: readProp(run.properties, PROP_FONT_SIZE) ?? null,
        bold: readProp(run.properties, PROP_BOLD) ?? null,
        italic: readProp(run.properties, PROP_ITALIC) ?? null,
      });
    }
  }

  return {
    cellId: cellIdOf(root),
    actionDescId: actionDescIdOf(root),
    paragraphId: paragraph.objectId,
    paragraphProperties: paragraph.properties,
    runRef,
    textRuns,
  };
};

/**
 * True when a run already carries every property value a change set asked for —
 * the post-write check that the format actually landed on the document, rather
 * than merely being accepted by the server.
 */
const runReflectsChanges = (run: ResolvedRun, changes: RunFormatChanges): boolean =>
  requestedRunProps(changes).every(propId => {
    const expected = overrideForRunProp(propId, changes);
    return expected === undefined || readProp(run.properties, propId) === expected;
  });

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

  const rewrittenRef = parseRefList(target.runRef)
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

/** Parse a run's `"true"`/`"false"` flag string to a boolean, or null when the property was absent. */
const flagToBool = (value: string | null): boolean | null => (value === null ? null : value === 'true');

const requireText = (raw: Record<string, unknown>): string => {
  if (typeof raw.text !== 'string' || raw.text.length === 0) {
    throw new FrameBridgeValidationError('format_text needs `text`: the exact visible text of the target paragraph.');
  }
  return raw.text;
};

const parseFormatArgs = (raw: Record<string, unknown>): RunFormatArgs => {
  const text = requireText(raw);
  const hasSize = typeof raw.sizePt === 'number' && Number.isFinite(raw.sizePt) && raw.sizePt > 0;
  const hasBold = typeof raw.bold === 'boolean';
  const hasItalic = typeof raw.italic === 'boolean';
  const hasUnderline = typeof raw.underline === 'boolean';
  const hasColor = typeof raw.colorHex === 'string' && /^[0-9a-fA-F]{6}$/.test(raw.colorHex);
  const hasFont = typeof raw.font === 'string' && raw.font.length > 0;
  if (!hasSize && !hasBold && !hasItalic && !hasUnderline && !hasColor && !hasFont) {
    throw new FrameBridgeValidationError(
      'format_text needs at least one valid change (sizePt, bold, italic, underline, colorHex, or font).',
    );
  }
  const requested = {
    ...(hasSize ? { sizePt: raw.sizePt as number } : {}),
    ...(hasBold ? { bold: raw.bold as boolean } : {}),
    ...(hasItalic ? { italic: raw.italic as boolean } : {}),
    ...(hasUnderline ? { underline: raw.underline as boolean } : {}),
    ...(hasColor ? { colorHex: (raw.colorHex as string).toUpperCase() } : {}),
    ...(hasFont ? { font: raw.font as string } : {}),
  };
  const changes: RunFormatChanges = {
    ...(requested.sizePt !== undefined ? { sizeHalfPt: Math.round(requested.sizePt * 2) } : {}),
    ...(requested.bold !== undefined ? { bold: requested.bold } : {}),
    ...(requested.italic !== undefined ? { italic: requested.italic } : {}),
    ...(requested.underline !== undefined ? { underline: requested.underline } : {}),
    ...(requested.colorHex !== undefined ? { colorHex: requested.colorHex } : {}),
    ...(requested.font !== undefined ? { font: requested.font } : {}),
  };
  return { text, changes, requested };
};

const CLASS_FILTER = [CLASS_PARAGRAPH, CLASS_RUN];

const isAppliedToFirstRun = (model: PodsModel, args: RunFormatArgs): boolean => {
  try {
    const state = resolveRunFormatTarget(model, args.text);
    const run = state.textRuns[0];
    return run !== undefined && runReflectsChanges(run, args.changes);
  } catch {
    return false;
  }
};

const summarizeFormat = (ctx: ResolvedTarget, args: RunFormatArgs): Record<string, unknown> => {
  const run = ctx.textRuns[0];
  return {
    text: args.text,
    runId: run?.objectId ?? '',
    before: {
      sizePt: run?.sizeHalfPt ? Number(run.sizeHalfPt) / 2 : null,
      bold: flagToBool(run?.bold ?? null),
      italic: flagToBool(run?.italic ?? null),
    },
    requested: args.requested,
  };
};

/** The `format_text` action: any run-property change on the paragraph matched by visible text. */
export const formatTextAction: PodsWriteActionSpec<RunFormatArgs, ResolvedTarget> = {
  kind: 'write',
  classFilter: CLASS_FILTER,
  parseArgs: parseFormatArgs,
  resolve: (model, args) => resolveRunFormatTarget(model, args.text),
  build: (ctx, args, mint: PodsMint) => buildRunFormatBody(ctx, args.changes, mint.guidToken, mint.headToken),
  isApplied: (model, _first, args) => isAppliedToFirstRun(model, args),
  idempotent: true,
  summarize: summarizeFormat,
};

/** The `set_font_size` action: the size-only run format, kept as its own name for the dedicated tool. */
export const setFontSizeAction: PodsWriteActionSpec<RunFormatArgs, ResolvedTarget> = {
  kind: 'write',
  classFilter: CLASS_FILTER,
  parseArgs: (raw): RunFormatArgs => {
    const text = requireText(raw);
    if (typeof raw.sizePt !== 'number' || !Number.isFinite(raw.sizePt) || raw.sizePt <= 0) {
      throw new FrameBridgeValidationError(
        'set_font_size needs `sizePt`: the new font size in points, greater than 0.',
      );
    }
    return {
      text,
      changes: { sizeHalfPt: Math.round(raw.sizePt * 2) },
      requested: { sizePt: raw.sizePt },
    };
  },
  resolve: (model, args) => resolveRunFormatTarget(model, args.text),
  build: (ctx, args, mint: PodsMint) => buildRunFormatBody(ctx, args.changes, mint.guidToken, mint.headToken),
  isApplied: (model, _first, args) => isAppliedToFirstRun(model, args),
  idempotent: true,
  summarize: (ctx, args) => {
    const run = ctx.textRuns[0];
    return {
      text: args.text,
      runId: run?.objectId ?? '',
      oldSizePt: run?.sizeHalfPt ? Number(run.sizeHalfPt) / 2 : null,
      newSizePt: args.requested.sizePt ?? null,
    };
  },
};
