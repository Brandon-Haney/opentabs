/**
 * Keeping a Word paragraph's per-run arrays consistent with its text.
 *
 * A paragraph's text is one string; its formatting is a list of run boundaries
 * (character offsets) plus parallel arrays holding one entry per run. A write
 * that changes the text must change the boundaries with it, or the runs describe
 * text that is no longer there — and must drop the entries of any run the edit
 * empties, so every array keeps one entry per run.
 */

import { PROP_TEXT, readProp } from './pods-model.js';
import {
  PROP_MODIFIED_TIME,
  PROP_PARA_ID,
  PROP_RUN_BOUNDARIES,
  PROP_TEXT_ID,
  RUN_FLAG_PROPS,
  RUN_LIST_PROPS,
} from './word-live-model.js';

/** A paragraph's runs as character spans, each with its index into the per-run arrays. */
interface RunSpan {
  start: number;
  end: number;
  run: number;
}

/** Parse the boundary list; an absent or empty value means a single run. */
const parseBoundaries = (value: string | undefined): number[] =>
  value === undefined || value.length === 0 ? [] : value.split(',').map(Number);

const spansOf = (boundaries: number[], length: number): RunSpan[] => {
  const edges = [0, ...boundaries, length];
  return boundaries.concat(length).map((end, run) => ({ start: edges[run] as number, end, run }));
};

/**
 * Where a character offset lands after `[start, end)` is replaced by `length`
 * characters. Offsets before the match stay; offsets after it shift by the
 * change in length; offsets inside it move to the end of the replacement, so the
 * replacement takes the formatting of the run the match starts in.
 */
const remapOffset = (offset: number, start: number, end: number, length: number): number => {
  if (offset <= start) return offset;
  if (offset >= end) return offset + length - (end - start);
  return start + length;
};

/** A paragraph's properties after replacing every occurrence of `find`, and how many there were. */
export interface ReplacedParagraph {
  properties: (string | number)[];
  text: string;
  count: number;
}

/** Non-overlapping occurrences of `find` in `text`, left to right. */
export const findOccurrences = (text: string, find: string): number[] => {
  const found: number[] = [];
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) found.push(at);
  return found;
};

/**
 * Rewrite a paragraph's property list for `text`, given each run's new span.
 * Runs left empty are dropped from every per-run array; a paragraph left with
 * no text keeps its first run, since a paragraph always has one.
 */
const rewriteRuns = (
  properties: (string | number)[],
  text: string,
  spans: RunSpan[],
  runCount: number,
): (string | number)[] => {
  const nonEmpty = spans.filter(span => span.end > span.start);
  const kept = nonEmpty.length > 0 ? nonEmpty : spans.slice(0, 1);
  const keptRuns = kept.map(span => span.run);
  const boundaries = kept.slice(1).map(span => span.start);

  const rewritten: (string | number)[] = [];
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_TEXT) {
      rewritten.push(key, text);
    } else if (key === PROP_RUN_BOUNDARIES) {
      if (boundaries.length > 0) rewritten.push(key, boundaries.join(','));
    } else if (
      typeof key === 'number' &&
      RUN_FLAG_PROPS.includes(key) &&
      typeof value === 'string' &&
      value.length === runCount
    ) {
      rewritten.push(key, keptRuns.map(run => value[run]).join(''));
    } else if (typeof key === 'number' && RUN_LIST_PROPS.includes(key) && typeof value === 'string') {
      const entries = value.length === 0 ? [] : value.split(',');
      rewritten.push(key, entries.length === runCount ? keptRuns.map(run => entries[run]).join(',') : value);
    } else {
      rewritten.push(key, value);
    }
  }
  return rewritten;
};

/** Replace every non-overlapping occurrence of `find` in a paragraph, keeping its runs consistent. */
export const replaceInParagraph = (
  properties: (string | number)[],
  find: string,
  replacement: string,
): ReplacedParagraph => {
  const original = readProp(properties, PROP_TEXT) ?? '';
  const occurrences = findOccurrences(original, find);
  if (occurrences.length === 0) return { properties, text: original, count: 0 };

  const boundaries = parseBoundaries(readProp(properties, PROP_RUN_BOUNDARIES));
  let spans = spansOf(boundaries, original.length);
  let text = original;
  // Right to left, so each occurrence's offsets are still those of the original text.
  for (const start of [...occurrences].reverse()) {
    const end = start + find.length;
    text = text.slice(0, start) + replacement + text.slice(end);
    spans = spans.map(span => ({
      ...span,
      start: remapOffset(span.start, start, end, replacement.length),
      end: remapOffset(span.end, start, end, replacement.length),
    }));
  }
  return {
    properties: rewriteRuns(properties, text, spans, boundaries.length + 1),
    text,
    count: occurrences.length,
  };
};

/**
 * The properties of a new single-run paragraph modelled on `source`.
 *
 * Everything the source carries for the paragraph as a whole — its style, list
 * membership, indents, spacing — is copied, the way the editor's own Enter
 * copies it. What describes the source's text is not: the new paragraph is one
 * run carrying the formatting of the source's longest run, it gets its own
 * identifiers, and no modification stamp is carried over.
 */
export const newParagraphProperties = (
  source: (string | number)[],
  text: string,
  paraId: number,
  textId: number,
): (string | number)[] => {
  const original = readProp(source, PROP_TEXT) ?? '';
  const boundaries = parseBoundaries(readProp(source, PROP_RUN_BOUNDARIES));
  const runCount = boundaries.length + 1;
  const spans = spansOf(boundaries, original.length);
  const dominant = spans.reduce((best, span) => (span.end - span.start > best.end - best.start ? span : best)).run;

  const properties: (string | number)[] = [];
  for (let i = 0; i + 1 < source.length; i += 2) {
    const key = source[i];
    const value = source[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_RUN_BOUNDARIES || key === PROP_MODIFIED_TIME) continue;
    if (key === PROP_TEXT) {
      properties.push(key, text);
    } else if (key === PROP_PARA_ID) {
      properties.push(key, String(paraId));
    } else if (key === PROP_TEXT_ID) {
      properties.push(key, String(textId));
    } else if (typeof key === 'number' && RUN_FLAG_PROPS.includes(key)) {
      if (typeof value === 'string' && value.length === runCount) properties.push(key, value[dominant] as string);
    } else if (typeof key === 'number' && RUN_LIST_PROPS.includes(key) && typeof value === 'string') {
      const entries = value.length === 0 ? [] : value.split(',');
      properties.push(key, entries.length === runCount ? (entries[dominant] as string) : value);
    } else {
      properties.push(key, value);
    }
  }
  return properties;
};

/**
 * A paragraph identifier in the range Word accepts (a positive 31-bit value),
 * derived from a per-call seed so a retry re-sends the same paragraph rather
 * than a different one.
 */
export const paragraphIdFrom = (seed: string, slot: number): number => {
  let hash = 2166136261;
  for (const char of `${seed}:${slot}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 1) % 0x7ffffffe) + 1;
};
