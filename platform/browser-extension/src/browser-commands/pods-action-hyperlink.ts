/**
 * Pods `set_hyperlink` action — turn part of a paragraph into a link, live.
 *
 * PowerPoint on the web does not model a hyperlink as a run property or as a
 * relationship the way the saved OOXML package does. It splices a **Word field
 * code straight into the paragraph's text** and hides it with run flags, exactly
 * as `HYPERLINK "…"` appears in a `.docx` field:
 *
 * ```
 * " Fusion Pilot Timeline: Key ﷟HYPERLINK \"https://example.com/sop\"Milestones"
 *                               ^ the field code begins            display text ^
 * ```
 *
 * So the paragraph gains three stretches where it had one: the text before the
 * link, the field code itself — a run carrying no formatting at all, because it
 * is never drawn — and the link's display text, whose run is a copy of the
 * formatting it already had plus the flags that mark it as a link.
 *
 * Decoded 2026-09-03 from the editor's own Insert Link; see
 * `plugins/powerpoint/docs/pods-action-catalog.md`. The property names below are
 * the client's own, from the registry extracted from its bundles — `134225430`
 * is literally called `isHidden`.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { type ResolvedTarget, rangeOf, resolveRunFormatTarget } from './pods-action-run-format.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import { CLASS_PARAGRAPH, CLASS_RUN, type PodsModel, PROP_RUN_REF, PROP_TEXT, readProp } from './pods-model.js';
import {
  boundariesOf,
  FIRST_RUN_SLOT,
  formatRunBoundaries,
  mergeAdjacent,
  PROP_RUN_BOUNDARIES,
  type RunSegment,
  type TextRange,
} from './pods-text-runs.js';

/** Run flags the editor writes on a field. Names are the client's own. */
const PROP_IN_FIELD = 134225428;
const PROP_IS_HIDDEN = 134225430;
const PROP_FIELD_CONTENT = 134225433;
/**
 * Set on the run that shows a link's text. The editor leaves it `true` when the
 * link is removed, so it does not mean "this run is a link" and removal must not
 * clear it — whatever it marks outlives the field.
 */
const PROP_HYPERLINK_DISPLAY = 134236593;

/**
 * The character that opens a field code in the text stream (U+FDDF). It is a
 * noncharacter, so it can never collide with anything a person typed.
 */
export const FIELD_CODE_PREFIX = '﷟';

/** The field code for a hyperlink, spliced in front of the display text. */
export const hyperlinkFieldCode = (url: string): string => `${FIELD_CODE_PREFIX}HYPERLINK "${url}"`;

/** True when a paragraph's text already carries a field code. */
export const containsFieldCode = (text: string): boolean => text.includes(FIELD_CODE_PREFIX);

/** The validated arguments of a `set_hyperlink` action. */
export interface HyperlinkArgs {
  /** Exact visible text of the target paragraph. */
  text: string;
  /** The stretch to turn into a link; the whole paragraph when absent. */
  match?: { value: string; occurrence: number };
  /** The address to link to. Absent when removing. */
  url?: string;
  /** Strip the link the paragraph already carries instead of adding one. */
  remove?: boolean;
}

/**
 * A URL this action is willing to write, normalised.
 *
 * The field code delimits the target with a double quote, so a URL containing one
 * would end the code early and leave the rest as visible text. Rejecting it is the
 * only safe answer — escaping is not something the wire format offers.
 */
const parseUrl = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new FrameBridgeValidationError('set_hyperlink needs `url`: the address the text should link to.');
  }
  const url = raw.trim();
  if (url.includes('"')) {
    throw new FrameBridgeValidationError(
      'A hyperlink URL cannot contain a double quote — the field code uses it as its delimiter. Percent-encode it as %22.',
    );
  }
  if (!/^(?:https?:\/\/|mailto:)/i.test(url)) {
    throw new FrameBridgeValidationError(
      `"${url}" is not a link target this can write. Use an http:// or https:// address, or a mailto: address.`,
    );
  }
  return url;
};

/**
 * Build the type-3 revision that links `range` to `url`.
 *
 * The paragraph is resubmitted with the field code inserted at the start of the
 * range, its boundary offsets recut around the three new stretches, and its
 * reference list naming the two minted runs. Everything after the link shifts by
 * the length of the code, because the code lives in the text.
 *
 * Pure and deterministic, for unit testing against the captured write.
 */
export const buildHyperlinkBody = (
  target: ResolvedTarget,
  range: TextRange,
  url: string,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => {
  if (containsFieldCode(target.text)) {
    throw new FrameBridgeValidationError(
      `"${target.paragraphId}" already contains a field code, so it may already hold a link. Removing or retargeting an existing link is not supported yet; edit it in the editor.`,
    );
  }

  // The display run copies the formatting the linked words already had. A range
  // crossing two differently formatted stretches has no single answer to copy, and
  // silently picking one would restyle the rest of the link.
  const covering = target.segments.filter(s => Math.max(s.start, range.start) < Math.min(s.end, range.end));
  const [source, ...extra] = covering;
  if (source === undefined) {
    throw new FrameBridgeValidationError(`Text range (${range.start}-${range.end}) falls outside the paragraph.`);
  }
  if (extra.length > 0) {
    throw new FrameBridgeValidationError(
      'The text to link spans more than one formatting run. Link a stretch that is formatted consistently, or format it the same way first.',
    );
  }
  const sourceRun = target.runsByRef.get(source.ref);
  if (sourceRun === undefined) {
    throw new FrameBridgeValidationError(
      `Run ${source.ref} is referenced by the paragraph but missing from the live model. Re-read the deck and retry.`,
    );
  }

  const fieldCode = hyperlinkFieldCode(url);
  const shift = fieldCode.length;
  const codeSlot = FIRST_RUN_SLOT;
  const displaySlot = FIRST_RUN_SLOT + 1;

  const rebuilt: RunSegment[] = [];
  for (const segment of target.segments) {
    const end = Math.min(segment.end, range.start);
    if (segment.start < end) rebuilt.push({ start: segment.start, end, ref: segment.ref });
  }
  rebuilt.push({ start: range.start, end: range.start + shift, ref: `{${guidToken}}{${codeSlot}}` });
  rebuilt.push({ start: range.start + shift, end: range.end + shift, ref: `{${guidToken}}{${displaySlot}}` });
  for (const segment of target.segments) {
    const start = Math.max(segment.start, range.end);
    if (start < segment.end) rebuilt.push({ start: start + shift, end: segment.end + shift, ref: segment.ref });
  }
  const segments = mergeAdjacent(rebuilt);

  const newText = `${target.text.slice(0, range.start)}${fieldCode}${target.text.slice(range.start)}`;
  const paragraphProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < target.paragraphProperties.length; i += 2) {
    const key = target.paragraphProperties[i];
    const value = target.paragraphProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_RUN_BOUNDARIES) continue;
    if (key === PROP_TEXT) {
      paragraphProperties.push(key, newText);
    } else if (key === PROP_RUN_REF) {
      paragraphProperties.push(key, segments.map(s => s.ref).join(','));
    } else {
      paragraphProperties.push(key, value);
    }
  }
  const boundaries = boundariesOf(segments);
  if (boundaries.length > 0) paragraphProperties.push(PROP_RUN_BOUNDARIES, formatRunBoundaries(boundaries));

  // The field code is never drawn, so its run carries the hidden flags and nothing
  // else — no size, no colour, no typeface.
  const codeRun = {
    ObjectId: `${guidToken}|${codeSlot}`,
    ClassId: CLASS_RUN,
    Properties: sortPropertiesById([PROP_IN_FIELD, 'true', PROP_IS_HIDDEN, 'true', PROP_FIELD_CONTENT, 'true']),
  };
  const displayRun = {
    ObjectId: `${guidToken}|${displaySlot}`,
    ClassId: CLASS_RUN,
    Properties: sortPropertiesById([
      ...sourceRun.properties,
      PROP_IN_FIELD,
      'true',
      PROP_FIELD_CONTENT,
      'true',
      PROP_HYPERLINK_DISPLAY,
      'true',
    ]),
  };

  const revision = {
    Id: `${guidToken}|2`,
    FileId: null,
    RelativePath: null,
    CellId: target.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: headToken,
    RootObjectDescriptors: null,
    ObjectGroups: [
      {
        Id: `${guidToken}|3`,
        Objects: [
          {
            ObjectId: target.actionDescId,
            ClassId: 131140,
            Properties: [134236193, 'true', 335562934, '1', 469780989, 'InsertHyperlink'],
          },
          {
            ObjectId: target.paragraphId,
            ClassId: CLASS_PARAGRAPH,
            Properties: sortPropertiesById(paragraphProperties),
          },
          codeRun,
          displayRun,
        ],
      },
    ],
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

/**
 * Build the type-3 revision that strips the link a paragraph carries.
 *
 * The inverse of {@link buildHyperlinkBody}, and it works off the decoded structure
 * rather than by parsing the text: the field code is whichever stretch is formatted
 * by a run marked hidden, and the stretch immediately after it is the words the
 * reader sees. Removing the link means dropping the code from the text and giving
 * those words a run with the field flags taken off — everything else about their
 * formatting is kept.
 *
 * This exists because our writes reach the deck through the co-authoring channel,
 * so the editor treats them as a collaborator's edit and `Ctrl+Z` will not take
 * them back. Without a programmatic inverse a link we add cannot be undone at all.
 *
 * The field flags are written `false`, never dropped. A revision is merged onto the
 * document, so a property this write omits keeps the value it already had — omission
 * means "unchanged", not "off". Dropping them instead of clearing them leaves the
 * run half a field, and the editor repairs that by rebuilding the link with a target
 * guessed from the visible words. Captured from the editor's own `RemoveHyperlink`.
 */
export const buildRemoveHyperlinkBody = (
  target: ResolvedTarget,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => {
  const codeIndex = target.segments.findIndex(segment => {
    const run = target.runsByRef.get(segment.ref);
    return run !== undefined && readProp(run.properties, PROP_IS_HIDDEN) === 'true';
  });
  if (codeIndex === -1) {
    throw new FrameBridgeValidationError(
      `"${target.paragraphId}" carries no hyperlink to remove — no stretch of it is formatted by a hidden field-code run.`,
    );
  }
  const code = target.segments[codeIndex] as RunSegment;
  const display = target.segments[codeIndex + 1];
  if (display === undefined) {
    throw new FrameBridgeValidationError(
      `"${target.paragraphId}" has a field code with no text after it, so there is nothing to keep. Repair it in the editor.`,
    );
  }
  const displayRun = target.runsByRef.get(display.ref);
  if (displayRun === undefined) {
    throw new FrameBridgeValidationError(
      `Run ${display.ref} is referenced by the paragraph but missing from the live model. Re-read the deck and retry.`,
    );
  }

  const shift = code.end - code.start;
  const plainSlot = FIRST_RUN_SLOT;
  const rebuilt: RunSegment[] = [];
  for (const segment of target.segments.slice(0, codeIndex)) rebuilt.push({ ...segment });
  rebuilt.push({ start: code.start, end: display.end - shift, ref: `{${guidToken}}{${plainSlot}}` });
  for (const segment of target.segments.slice(codeIndex + 2)) {
    rebuilt.push({ start: segment.start - shift, end: segment.end - shift, ref: segment.ref });
  }
  const segments = mergeAdjacent(rebuilt);

  const newText = `${target.text.slice(0, code.start)}${target.text.slice(code.end)}`;
  const paragraphProperties: (string | number)[] = [];
  for (let i = 0; i + 1 < target.paragraphProperties.length; i += 2) {
    const key = target.paragraphProperties[i];
    const value = target.paragraphProperties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_RUN_BOUNDARIES) continue;
    if (key === PROP_TEXT) {
      paragraphProperties.push(key, newText);
    } else if (key === PROP_RUN_REF) {
      paragraphProperties.push(key, segments.map(segment => segment.ref).join(','));
    } else {
      paragraphProperties.push(key, value);
    }
  }
  const boundaries = boundariesOf(segments);
  if (boundaries.length > 0) paragraphProperties.push(PROP_RUN_BOUNDARIES, formatRunBoundaries(boundaries));

  // The words keep every property they had; the two flags that made them a field are
  // set false rather than removed, because an omitted property is left unchanged.
  const cleared = new Set([PROP_IN_FIELD, PROP_FIELD_CONTENT]);
  const plainProperties: (string | number)[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 1 < displayRun.properties.length; i += 2) {
    const key = displayRun.properties[i];
    const value = displayRun.properties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (typeof key === 'number') seen.add(key);
    plainProperties.push(key, typeof key === 'number' && cleared.has(key) ? 'false' : value);
  }
  for (const flag of cleared) {
    if (!seen.has(flag)) plainProperties.push(flag, 'false');
  }

  const revision = {
    Id: `${guidToken}|2`,
    FileId: null,
    RelativePath: null,
    CellId: target.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: headToken,
    RootObjectDescriptors: null,
    ObjectGroups: [
      {
        Id: `${guidToken}|3`,
        Objects: [
          {
            ObjectId: target.actionDescId,
            ClassId: 131140,
            Properties: [134236193, 'true', 335562934, '1', 469780989, 'RemoveHyperlink'],
          },
          {
            ObjectId: target.paragraphId,
            ClassId: CLASS_PARAGRAPH,
            Properties: sortPropertiesById(paragraphProperties),
          },
          {
            ObjectId: `${guidToken}|${plainSlot}`,
            ClassId: CLASS_RUN,
            Properties: sortPropertiesById(plainProperties),
          },
        ],
      },
    ],
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

const parseHyperlinkArgs = (raw: Record<string, unknown>): HyperlinkArgs => {
  if (typeof raw.text !== 'string' || raw.text.length === 0) {
    throw new FrameBridgeValidationError('set_hyperlink needs `text`: the exact visible text of the paragraph.');
  }
  const remove = raw.remove === true;
  // Removal targets whatever link the paragraph holds, so it needs no url and no
  // match — asking for either would imply a choice the paragraph does not offer.
  const url = remove ? undefined : parseUrl(raw.url);
  if (remove) return { text: raw.text, remove: true };
  if (raw.match === undefined) return { text: raw.text, url };
  if (typeof raw.match !== 'string' || raw.match.length === 0) {
    throw new FrameBridgeValidationError('`match` must be a non-empty substring of the paragraph to link.');
  }
  const occurrence = raw.occurrence === undefined ? 1 : raw.occurrence;
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
    throw new FrameBridgeValidationError('`occurrence` must be a whole number of 1 or more.');
  }
  return { text: raw.text, match: { value: raw.match, occurrence }, url };
};

/** The paragraph's text now reflects the request — the proof the write landed. */
const isApplied = (model: PodsModel, args: HyperlinkArgs, paragraphId: string): boolean => {
  const paragraph = model.objects.find(o => o.classId === CLASS_PARAGRAPH && o.objectId === paragraphId);
  const text = paragraph ? readProp(paragraph.properties, PROP_TEXT) : undefined;
  if (text === undefined) return false;
  return args.remove === true ? !containsFieldCode(text) : text.includes(hyperlinkFieldCode(args.url ?? ''));
};

/** The `set_hyperlink` action: link a stretch of a paragraph, live in the open deck. */
export const setHyperlinkAction: PodsWriteActionSpec<HyperlinkArgs, ResolvedTarget> = {
  kind: 'write',
  classFilter: [CLASS_PARAGRAPH, CLASS_RUN],
  parseArgs: parseHyperlinkArgs,
  resolve: (model, args) => resolveRunFormatTarget(model, args.text),
  build: (ctx, args, mint: PodsMint) =>
    args.remove === true
      ? buildRemoveHyperlinkBody(ctx, mint.guidToken, mint.headToken)
      : buildHyperlinkBody(ctx, rangeOf(ctx, args), args.url ?? '', mint.guidToken, mint.headToken),
  isApplied: (model, first, args) => isApplied(model, args, first.paragraphId),
  // The paragraph text changes, so a re-resolve by the original text would fail and
  // a blind re-issue could splice a second field code into the same paragraph.
  idempotent: false,
  summarize: (ctx, args) => {
    if (args.remove === true) {
      return { text: args.text, linked: '', url: '', removed: true, paragraphId: ctx.paragraphId };
    }
    const range = rangeOf(ctx, args);
    return {
      text: args.text,
      linked: ctx.text.slice(range.start, range.end),
      url: args.url ?? '',
      paragraphId: ctx.paragraphId,
    };
  },
  dryRunExtras: (ctx, args) => ({ text: args.text, url: args.url ?? '', paragraphId: ctx.paragraphId }),
};
