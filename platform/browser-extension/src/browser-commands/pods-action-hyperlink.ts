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
import {
  CLASS_PARAGRAPH,
  CLASS_RUN,
  type PodsModel,
  type PodsObject,
  PROP_RUN_REF,
  PROP_TEXT,
  readProp,
} from './pods-model.js';
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

/** The validated arguments of a `set_hyperlink` action. */
export interface HyperlinkArgs {
  /** Exact text of the target paragraph, including any existing link's hidden field code. */
  text: string;
  /** The stretch to turn into a link; the whole paragraph when absent. */
  match?: { value: string; occurrence: number };
  /** The address to link to. Absent when removing. */
  url?: string;
  /**
   * Strip a link the paragraph carries instead of adding one. With `match`, the link
   * whose text the match falls in; without it, the paragraph's only link.
   */
  remove?: boolean;
}

/**
 * One link a paragraph already carries: its hidden field-code stretch and the
 * display stretches after it, as indexes into the target's segments, and the
 * character span both cover. Text that overlaps `start`–`end` belongs to the link.
 */
export interface LinkSpan {
  codeIndex: number;
  /** Index of the last display segment; the display runs are `codeIndex + 1` through this. */
  lastDisplayIndex: number;
  start: number;
  end: number;
  /** The words the reader sees as the link. */
  display: string;
}

/**
 * The links a paragraph carries, read from its decoded structure rather than its
 * text. A link is a stretch formatted by a hidden field-code run followed by the
 * stretches whose runs are still marked in-field — the words the reader clicks.
 * A paragraph can carry several; the editor writes each one as its own pair.
 */
export const linkSpansOf = (target: ResolvedTarget): LinkSpan[] => {
  const runFlag = (index: number, prop: number): string | undefined => {
    const segment = target.segments[index];
    const run = segment === undefined ? undefined : target.runsByRef.get(segment.ref);
    return run === undefined ? undefined : readProp(run.properties, prop);
  };
  const spans: LinkSpan[] = [];
  for (let index = 0; index < target.segments.length; index++) {
    if (runFlag(index, PROP_IS_HIDDEN) !== 'true') continue;
    let last = index;
    while (
      last + 1 < target.segments.length &&
      runFlag(last + 1, PROP_IS_HIDDEN) !== 'true' &&
      runFlag(last + 1, PROP_IN_FIELD) === 'true'
    ) {
      last++;
    }
    const code = target.segments[index] as RunSegment;
    const end = (target.segments[last] as RunSegment).end;
    spans.push({
      codeIndex: index,
      lastDisplayIndex: last,
      start: code.start,
      end,
      display: target.text.slice(code.end, end),
    });
    index = last;
  }
  return spans;
};

const overlaps = (span: { start: number; end: number }, range: TextRange): boolean =>
  Math.max(span.start, range.start) < Math.min(span.end, range.end);

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
  // A paragraph may hold other links; the new one only has to stay clear of them.
  // The match is found in the raw text, which includes each link's hidden field
  // code, so a hit inside a code's URL is caught here as well as one on its words.
  const clash = linkSpansOf(target).find(span => overlaps(span, range));
  if (clash !== undefined) {
    throw new FrameBridgeValidationError(
      `The text to link overlaps the existing link "${clash.display}". To change that link, remove it first with \`remove: true\` and \`match: "${clash.display}"\`. If the words you mean appear again outside it, pick that one with \`occurrence\`.`,
    );
  }

  // The display run copies the formatting the linked words already had. A range
  // crossing two differently formatted stretches has no single answer to copy, and
  // silently picking one would restyle the rest of the link.
  //
  // Segments are not formatting: the editor cuts a paragraph at every line wrap
  // and points both sides at the same run, so a word that wraps covers two
  // segments of one run. Merging those first, and then accepting runs whose
  // properties are identical, leaves only a real formatting change to refuse.
  const covering = mergeAdjacent(target.segments).filter(
    s => Math.max(s.start, range.start) < Math.min(s.end, range.end),
  );
  const [source] = covering;
  if (source === undefined) {
    throw new FrameBridgeValidationError(`Text range (${range.start}-${range.end}) falls outside the paragraph.`);
  }
  const coveringRuns = covering.map(segment => {
    const run = target.runsByRef.get(segment.ref);
    if (run === undefined) {
      throw new FrameBridgeValidationError(
        `Run ${segment.ref} is referenced by the paragraph but missing from the live model. Re-read the deck and retry.`,
      );
    }
    return run;
  });
  const sourceRun = coveringRuns[0] as PodsObject;
  const sourceFormatting = JSON.stringify(sortPropertiesById(sourceRun.properties));
  if (coveringRuns.some(run => JSON.stringify(sortPropertiesById(run.properties)) !== sourceFormatting)) {
    throw new FrameBridgeValidationError(
      'The text to link spans differently formatted text. Link a stretch that is formatted consistently, or format it the same way first.',
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
 * The link a removal targets: the one `range` falls in, or — with no range — the
 * paragraph's only link. Several links and no range is ambiguous, so the error
 * lists them rather than guessing.
 */
export const selectLinkToRemove = (target: ResolvedTarget, range: TextRange | undefined): LinkSpan => {
  const spans = linkSpansOf(target);
  const listed = (): string => spans.map(span => `"${span.display}"`).join(', ');
  if (spans.length === 0) {
    throw new FrameBridgeValidationError(
      `"${target.paragraphId}" carries no hyperlink to remove — no stretch of it is formatted by a hidden field-code run.`,
    );
  }
  if (range === undefined) {
    if (spans.length === 1) return spans[0] as LinkSpan;
    throw new FrameBridgeValidationError(
      `The paragraph carries ${spans.length} links (${listed()}). Pass \`match\` with the words of the one to remove.`,
    );
  }
  const hit = spans.find(span => overlaps(span, range));
  if (hit === undefined) {
    throw new FrameBridgeValidationError(
      `\`match\` does not fall inside a link. The paragraph's links are ${listed()}.`,
    );
  }
  return hit;
};

/** The paragraph text with the field code at `code` taken out; the link's words stay. */
const removedLinkText = (text: string, code: TextRange): string =>
  `${text.slice(0, code.start)}${text.slice(code.end)}`;

/** A display run's properties with the two field flags written `false` and everything else kept. */
const clearedFieldFlags = (properties: (string | number)[]): (string | number)[] => {
  const cleared = new Set([PROP_IN_FIELD, PROP_FIELD_CONTENT]);
  const out: (string | number)[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (typeof key === 'number') seen.add(key);
    out.push(key, typeof key === 'number' && cleared.has(key) ? 'false' : value);
  }
  for (const flag of cleared) {
    if (!seen.has(flag)) out.push(flag, 'false');
  }
  return out;
};

/**
 * Build the type-3 revision that strips one link from a paragraph.
 *
 * The inverse of {@link buildHyperlinkBody}, and it works off the decoded structure
 * rather than by parsing the text: `link` names the hidden field-code stretch and
 * the in-field stretches after it, which are the words the reader sees. Removing
 * the link means dropping the code from the text and giving those words runs with
 * the field flags taken off — everything else about their formatting is kept. Any
 * other link in the paragraph is left as it is.
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
  link: LinkSpan,
  guidToken: string,
  headToken: string,
): Record<string, unknown> => {
  const code = target.segments[link.codeIndex] as RunSegment;
  const displays = target.segments.slice(link.codeIndex + 1, link.lastDisplayIndex + 1);
  if (displays.length === 0) {
    throw new FrameBridgeValidationError(
      `"${target.paragraphId}" has a field code with no text after it, so there is nothing to keep. Repair it in the editor.`,
    );
  }
  // Each display run keeps its own formatting in a plain run of its own, minted
  // from FIRST_RUN_SLOT up, so a link over differently formatted words comes back
  // as those words, not as one run copied across all of them. A display run the
  // editor split at a line wrap appears as several segments but mints one run.
  const slotByRef = new Map<string, number>();
  for (const display of displays) {
    if (!slotByRef.has(display.ref)) slotByRef.set(display.ref, FIRST_RUN_SLOT + slotByRef.size);
  }
  const displayRuns = [...slotByRef].map(([ref, slot]) => {
    const run = target.runsByRef.get(ref);
    if (run === undefined) {
      throw new FrameBridgeValidationError(
        `Run ${ref} is referenced by the paragraph but missing from the live model. Re-read the deck and retry.`,
      );
    }
    return { run, slot };
  });

  const shift = code.end - code.start;
  const rebuilt: RunSegment[] = [];
  for (const segment of target.segments.slice(0, link.codeIndex)) rebuilt.push({ ...segment });
  for (const display of displays) {
    rebuilt.push({
      start: display.start - shift,
      end: display.end - shift,
      ref: `{${guidToken}}{${slotByRef.get(display.ref)}}`,
    });
  }
  for (const segment of target.segments.slice(link.lastDisplayIndex + 1)) {
    rebuilt.push({ start: segment.start - shift, end: segment.end - shift, ref: segment.ref });
  }
  const segments = mergeAdjacent(rebuilt);

  const newText = removedLinkText(target.text, code);
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

  const plainRuns = displayRuns.map(({ run, slot }) => ({
    ObjectId: `${guidToken}|${slot}`,
    ClassId: CLASS_RUN,
    Properties: sortPropertiesById(clearedFieldFlags(run.properties)),
  }));

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
          ...plainRuns,
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

/** A `match`/`occurrence` pair, validated; undefined when no `match` was given. */
const parseMatch = (raw: Record<string, unknown>): HyperlinkArgs['match'] => {
  if (raw.match === undefined) return undefined;
  if (typeof raw.match !== 'string' || raw.match.length === 0) {
    throw new FrameBridgeValidationError('`match` must be a non-empty substring of the paragraph.');
  }
  const occurrence = raw.occurrence === undefined ? 1 : raw.occurrence;
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
    throw new FrameBridgeValidationError('`occurrence` must be a whole number of 1 or more.');
  }
  return { value: raw.match, occurrence };
};

const parseHyperlinkArgs = (raw: Record<string, unknown>): HyperlinkArgs => {
  if (typeof raw.text !== 'string' || raw.text.length === 0) {
    throw new FrameBridgeValidationError(
      'set_hyperlink needs `text`: the exact text of the paragraph, including any existing link code.',
    );
  }
  const match = parseMatch(raw);
  // Removal needs no url; `match`, when given, picks which of the paragraph's links to take off.
  if (raw.remove === true) return { text: raw.text, remove: true, ...(match && { match }) };
  return { text: raw.text, url: parseUrl(raw.url), ...(match && { match }) };
};

/** The range `match` selects, or undefined when the arguments carry none. */
const matchRangeOf = (target: ResolvedTarget, args: HyperlinkArgs): TextRange | undefined =>
  args.match === undefined ? undefined : rangeOf(target, args);

/**
 * The paragraph text the write produces, computed from the text it was built on.
 * Comparing against it exactly is the proof the write landed: a substring test
 * cannot tell this link from another one already in the paragraph.
 */
const expectedText = (target: ResolvedTarget, args: HyperlinkArgs): string => {
  if (args.remove === true) {
    const link = selectLinkToRemove(target, matchRangeOf(target, args));
    return removedLinkText(target.text, target.segments[link.codeIndex] as RunSegment);
  }
  const { start } = rangeOf(target, args);
  return `${target.text.slice(0, start)}${hyperlinkFieldCode(args.url ?? '')}${target.text.slice(start)}`;
};

/** The paragraph now holds exactly the text the write produces. */
const isApplied = (model: PodsModel, first: ResolvedTarget, args: HyperlinkArgs): boolean => {
  const paragraph = model.objects.find(o => o.classId === CLASS_PARAGRAPH && o.objectId === first.paragraphId);
  const text = paragraph ? readProp(paragraph.properties, PROP_TEXT) : undefined;
  return text !== undefined && text === expectedText(first, args);
};

/** The `set_hyperlink` action: link a stretch of a paragraph, or take a link off, live in the open deck. */
export const setHyperlinkAction: PodsWriteActionSpec<HyperlinkArgs, ResolvedTarget> = {
  kind: 'write',
  classFilter: [CLASS_PARAGRAPH, CLASS_RUN],
  parseArgs: parseHyperlinkArgs,
  resolve: (model, args) => resolveRunFormatTarget(model, args.text),
  build: (ctx, args, mint: PodsMint) =>
    args.remove === true
      ? buildRemoveHyperlinkBody(ctx, selectLinkToRemove(ctx, matchRangeOf(ctx, args)), mint.guidToken, mint.headToken)
      : buildHyperlinkBody(ctx, rangeOf(ctx, args), args.url ?? '', mint.guidToken, mint.headToken),
  isApplied,
  // The paragraph text changes, so a re-resolve by the original text would fail and
  // a blind re-issue could splice a second field code into the same paragraph.
  idempotent: false,
  summarize: (ctx, args) => {
    if (args.remove === true) {
      const link = selectLinkToRemove(ctx, matchRangeOf(ctx, args));
      return { text: args.text, linked: link.display, url: '', removed: true, paragraphId: ctx.paragraphId };
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
