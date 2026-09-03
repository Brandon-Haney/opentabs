/**
 * Run segmentation — how a pods paragraph holds more than one format.
 *
 * A paragraph's text (`469769250`) is one string for the whole paragraph; runs
 * (`1179725`) carry formatting and no text of their own. Which formatting applies
 * where is expressed by two parallel properties:
 *
 * - `469769746` — the boundary offsets, comma-separated character positions into
 *   the text where the formatting changes. N runs means N-1 offsets, and the
 *   property is absent entirely on a single-run paragraph.
 * - `603987475` — one run reference per segment, in order. The SAME run may be
 *   referenced more than once: runs are shared formatting descriptors, not text
 *   spans. Bolding one word mid-paragraph leaves the head and tail segments both
 *   pointing at the original run object.
 *
 * Decoded 2026-09-03 from the editor's own range-bold write; see
 * `plugins/powerpoint/docs/pods-action-catalog.md`.
 *
 * This module is the pure segmentation layer every text action shares: read the
 * segments, re-cut them around a character range, write the two properties back.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';

/** Paragraph property holding the run-boundary offsets; absent on a single-run paragraph. */
export const PROP_RUN_BOUNDARIES = 469769746;

/**
 * Object-id slot the first minted run takes. Slots 2 and 3 are the revision and its
 * object group, so runs start above them and count upward; a write minting several
 * runs (a range spanning differently formatted text) uses one slot each.
 */
export const FIRST_RUN_SLOT = 4;

/** One stretch of a paragraph's text and the run that formats it. */
export interface RunSegment {
  /** Character offset where the segment starts, inclusive. */
  start: number;
  /** Character offset where the segment ends, exclusive. */
  end: number;
  /** The `{guid}{ctr}` run reference formatting this stretch. */
  ref: string;
}

/** A character range over a paragraph's text, `end` exclusive. */
export interface TextRange {
  start: number;
  end: number;
}

/** Parse the boundary-offset property (`"14,22"`) into numbers; an absent or empty value means none. */
export const parseRunBoundaries = (value: string | undefined): number[] => {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map(part => {
    const offset = Number(part.trim());
    if (!Number.isInteger(offset) || offset < 0) {
      throw new FrameBridgeValidationError(`Paragraph run boundaries are not integer offsets: "${value}".`);
    }
    return offset;
  });
};

/** Serialize boundary offsets back to the wire form; an empty list means the property is dropped. */
export const formatRunBoundaries = (boundaries: number[]): string => boundaries.join(',');

/**
 * Cut a paragraph's text into its formatted segments.
 *
 * The boundaries are interior split points, so `refs` must hold exactly one more
 * entry than `boundaries`. A model that disagrees is malformed rather than merely
 * surprising — re-cutting it would silently mis-assign formatting — so it fails here.
 */
export const segmentsOf = (textLength: number, boundaries: number[], refs: string[]): RunSegment[] => {
  if (refs.length === 0) return [];
  if (refs.length !== boundaries.length + 1) {
    throw new FrameBridgeValidationError(
      `Paragraph has ${refs.length} run references but ${boundaries.length} boundary offsets; ` +
        'the two must differ by exactly one. The live model is inconsistent — re-read the deck and retry.',
    );
  }
  const edges = [0, ...boundaries, textLength];
  const segments: RunSegment[] = [];
  for (let i = 0; i < refs.length; i++) {
    const start = edges[i] as number;
    const end = edges[i + 1] as number;
    const ref = refs[i] as string;
    if (end < start) {
      throw new FrameBridgeValidationError(`Paragraph run boundaries are out of order: ${boundaries.join(',')}.`);
    }
    segments.push({ start, end, ref });
  }
  return segments;
};

/** The boundary offsets a segment list implies: every interior edge, in order. */
export const boundariesOf = (segments: RunSegment[]): number[] => segments.slice(1).map(segment => segment.start);

/**
 * Collapse neighbouring segments that share a run, so the written list is minimal.
 *
 * Re-cutting can leave adjacent stretches pointing at the same run — reverting a
 * range to the formatting its neighbours already have, say. The editor never writes
 * a redundant boundary, and an extra one would claim a formatting change that is
 * not there, so they are merged away.
 */
export const mergeAdjacent = (segments: RunSegment[]): RunSegment[] => {
  const merged: RunSegment[] = [];
  for (const segment of segments) {
    if (segment.end <= segment.start) continue;
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.ref === segment.ref && previous.end === segment.start) {
      previous.end = segment.end;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
};

/** A run the re-cut needs minted: which slot it takes, and which existing run it derives from. */
export interface MintedRun {
  /** Object-id slot, so the builder can emit `<guid>|<slot>` and reference `{<guid>}{<slot>}`. */
  slot: number;
  /** The `{guid}{ctr}` reference of the run whose properties this one copies. */
  sourceRef: string;
}

/** The result of re-cutting a paragraph's segments around a range. */
export interface RecutSegments {
  segments: RunSegment[];
  /** New runs the write must define, in slot order. */
  minted: MintedRun[];
}

/**
 * Re-cut `segments` so that `range` is covered by freshly minted runs, leaving
 * everything outside it pointing at the runs it already had.
 *
 * A range that spans differently formatted stretches mints one run per stretch, each
 * deriving from the run it replaces — so bolding a selection that crosses a colour
 * change bolds both halves and keeps both colours, which is what the editor does and
 * what a person expects. Splitting is by character offset only; the caller decides
 * what the minted runs' properties become.
 *
 * Covered stretches that derive from the SAME run share a single minted run, because
 * one source plus one change set can only produce one result. That keeps the write
 * minimal and, once the neighbours are merged, lets a paragraph collapse back to a
 * single run — which is how formatting all of a two-run paragraph the same way
 * removes the boundary between them instead of leaving a split that says nothing.
 */
export const recutForRange = (segments: RunSegment[], range: TextRange, guidToken: string): RecutSegments => {
  if (range.end <= range.start) {
    throw new FrameBridgeValidationError(
      `Text range is empty (start ${range.start}, end ${range.end}) — nothing would be formatted.`,
    );
  }
  const recut: RunSegment[] = [];
  const minted: MintedRun[] = [];
  const slotForSource = new Map<string, number>();

  for (const segment of segments) {
    const overlapStart = Math.max(segment.start, range.start);
    const overlapEnd = Math.min(segment.end, range.end);
    if (overlapStart >= overlapEnd) {
      recut.push({ ...segment });
      continue;
    }
    let slot = slotForSource.get(segment.ref);
    if (slot === undefined) {
      slot = FIRST_RUN_SLOT + slotForSource.size;
      slotForSource.set(segment.ref, slot);
      minted.push({ slot, sourceRef: segment.ref });
    }
    if (segment.start < overlapStart) recut.push({ start: segment.start, end: overlapStart, ref: segment.ref });
    recut.push({ start: overlapStart, end: overlapEnd, ref: `{${guidToken}}{${slot}}` });
    if (overlapEnd < segment.end) recut.push({ start: overlapEnd, end: segment.end, ref: segment.ref });
  }

  if (minted.length === 0) {
    throw new FrameBridgeValidationError(
      `Text range (${range.start}-${range.end}) falls outside the paragraph's formatted text.`,
    );
  }
  return { segments: mergeAdjacent(recut), minted };
};

/**
 * Locate a substring in a paragraph's text as a character range.
 *
 * `occurrence` is 1-based, matching how a person counts ("the second time it says
 * Q3"). An unmatched or out-of-reach occurrence fails with the text quoted, so a
 * near-miss is a one-step fix rather than a guess.
 */
export const rangeOfMatch = (text: string, match: string, occurrence: number): TextRange => {
  if (match === '') throw new FrameBridgeValidationError('`match` is empty — pass the text to target.');
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    throw new FrameBridgeValidationError(`\`occurrence\` must be 1 or greater, got ${occurrence}.`);
  }
  let index = -1;
  for (let seen = 0; seen < occurrence; seen++) {
    index = text.indexOf(match, index + 1);
    if (index === -1) {
      const total = text.split(match).length - 1;
      throw new FrameBridgeValidationError(
        total === 0
          ? `"${match}" does not appear in "${text}".`
          : `"${match}" appears ${total} time(s) in "${text}", so occurrence ${occurrence} does not exist.`,
      );
    }
  }
  return { start: index, end: index + match.length };
};
