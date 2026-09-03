import { describe, expect, test } from 'vitest';

// Minimal Chrome stub so transitive module access at import time resolves.
(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const {
  boundariesOf,
  formatRunBoundaries,
  mergeAdjacent,
  parseRunBoundaries,
  rangeOfMatch,
  recutForRange,
  segmentsOf,
} = await import('./pods-text-runs.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { RunSegment } from './pods-text-runs.js';

const GUID = '__OTB_PODS_GUID__';

describe('parseRunBoundaries', () => {
  test('reads the comma-separated offsets a multi-run paragraph carries', () => {
    expect(parseRunBoundaries('14,22')).toEqual([14, 22]);
    expect(parseRunBoundaries('8')).toEqual([8]);
    expect(parseRunBoundaries(' 4 , 9 ')).toEqual([4, 9]);
  });

  test('an absent or empty value means a single-run paragraph', () => {
    expect(parseRunBoundaries(undefined)).toEqual([]);
    expect(parseRunBoundaries('')).toEqual([]);
    expect(parseRunBoundaries('   ')).toEqual([]);
  });

  test('a non-integer offset is a malformed model, not a value to guess at', () => {
    expect(() => parseRunBoundaries('4,x')).toThrow(FrameBridgeValidationError);
    expect(() => parseRunBoundaries('-1')).toThrow(FrameBridgeValidationError);
    expect(() => parseRunBoundaries('2.5')).toThrow(FrameBridgeValidationError);
  });

  test('round-trips through the wire form', () => {
    expect(formatRunBoundaries(parseRunBoundaries('14,22'))).toBe('14,22');
    expect(formatRunBoundaries([])).toBe('');
  });
});

describe('segmentsOf', () => {
  // The captured range-bold: " Fusion Pilot Timeline: Key Milestones" with "Timeline"
  // at 14..21, written as boundaries "14,22" over three run references.
  test('cuts the text at the boundaries, one segment per run reference', () => {
    const segments = segmentsOf(38, [14, 22], ['{a}{1}', '{b}{2}', '{a}{1}']);
    expect(segments).toEqual([
      { start: 0, end: 14, ref: '{a}{1}' },
      { start: 14, end: 22, ref: '{b}{2}' },
      { start: 22, end: 38, ref: '{a}{1}' },
    ]);
  });

  test('a single-run paragraph is one segment spanning the whole text', () => {
    expect(segmentsOf(10, [], ['{a}{1}'])).toEqual([{ start: 0, end: 10, ref: '{a}{1}' }]);
  });

  test('no references at all yields no segments', () => {
    expect(segmentsOf(10, [], [])).toEqual([]);
  });

  test('references and boundaries that disagree are refused rather than mis-assigned', () => {
    expect(() => segmentsOf(10, [4], ['{a}{1}'])).toThrow(FrameBridgeValidationError);
    expect(() => segmentsOf(10, [], ['{a}{1}', '{b}{2}'])).toThrow(FrameBridgeValidationError);
  });

  test('boundaries out of order are refused', () => {
    expect(() => segmentsOf(10, [6, 3], ['{a}{1}', '{b}{2}', '{c}{3}'])).toThrow(FrameBridgeValidationError);
  });
});

describe('boundariesOf', () => {
  test('reports every interior edge and nothing for a single segment', () => {
    const segments: RunSegment[] = [
      { start: 0, end: 14, ref: '{a}{1}' },
      { start: 14, end: 22, ref: '{b}{2}' },
      { start: 22, end: 38, ref: '{a}{1}' },
    ];
    expect(boundariesOf(segments)).toEqual([14, 22]);
    expect(boundariesOf([{ start: 0, end: 10, ref: '{a}{1}' }])).toEqual([]);
  });
});

describe('mergeAdjacent', () => {
  test('collapses neighbours that share a run', () => {
    expect(
      mergeAdjacent([
        { start: 0, end: 4, ref: '{a}{1}' },
        { start: 4, end: 10, ref: '{a}{1}' },
      ]),
    ).toEqual([{ start: 0, end: 10, ref: '{a}{1}' }]);
  });

  test('leaves neighbours with different runs alone', () => {
    const segments: RunSegment[] = [
      { start: 0, end: 4, ref: '{a}{1}' },
      { start: 4, end: 10, ref: '{b}{2}' },
    ];
    expect(mergeAdjacent(segments)).toEqual(segments);
  });

  test('drops empty segments', () => {
    expect(
      mergeAdjacent([
        { start: 0, end: 0, ref: '{a}{1}' },
        { start: 0, end: 4, ref: '{b}{2}' },
      ]),
    ).toEqual([{ start: 0, end: 4, ref: '{b}{2}' }]);
  });
});

describe('recutForRange', () => {
  const single = (): RunSegment[] => [{ start: 0, end: 38, ref: '{a}{1}' }];

  test('reproduces the captured range-bold shape: head, minted range, tail sharing the original run', () => {
    const { segments, minted } = recutForRange(single(), { start: 14, end: 22 }, GUID);
    expect(segments).toEqual([
      { start: 0, end: 14, ref: '{a}{1}' },
      { start: 14, end: 22, ref: `{${GUID}}{4}` },
      { start: 22, end: 38, ref: '{a}{1}' },
    ]);
    expect(boundariesOf(segments)).toEqual([14, 22]);
    expect(minted).toEqual([{ slot: 4, sourceRef: '{a}{1}' }]);
  });

  test('a range at the very start has no head segment', () => {
    const { segments } = recutForRange(single(), { start: 0, end: 6 }, GUID);
    expect(segments).toEqual([
      { start: 0, end: 6, ref: `{${GUID}}{4}` },
      { start: 6, end: 38, ref: '{a}{1}' },
    ]);
  });

  test('a range covering everything leaves one segment and no boundaries', () => {
    const { segments, minted } = recutForRange(single(), { start: 0, end: 38 }, GUID);
    expect(segments).toEqual([{ start: 0, end: 38, ref: `{${GUID}}{4}` }]);
    expect(boundariesOf(segments)).toEqual([]);
    expect(minted).toHaveLength(1);
  });

  test('a range spanning two runs mints one run per run, each deriving from its own source', () => {
    const segments: RunSegment[] = [
      { start: 0, end: 10, ref: '{a}{1}' },
      { start: 10, end: 20, ref: '{b}{2}' },
    ];
    const recut = recutForRange(segments, { start: 5, end: 15 }, GUID);
    expect(recut.minted).toEqual([
      { slot: 4, sourceRef: '{a}{1}' },
      { slot: 5, sourceRef: '{b}{2}' },
    ]);
    expect(recut.segments).toEqual([
      { start: 0, end: 5, ref: '{a}{1}' },
      { start: 5, end: 10, ref: `{${GUID}}{4}` },
      { start: 10, end: 15, ref: `{${GUID}}{5}` },
      { start: 15, end: 20, ref: '{b}{2}' },
    ]);
  });

  test('covered stretches sharing one source run share one minted run, collapsing the split', () => {
    const segments: RunSegment[] = [
      { start: 0, end: 10, ref: '{a}{1}' },
      { start: 10, end: 20, ref: '{a}{1}' },
    ];
    const recut = recutForRange(segments, { start: 0, end: 20 }, GUID);
    expect(recut.minted).toEqual([{ slot: 4, sourceRef: '{a}{1}' }]);
    expect(recut.segments).toEqual([{ start: 0, end: 20, ref: `{${GUID}}{4}` }]);
  });

  test('an empty or inverted range is refused', () => {
    expect(() => recutForRange(single(), { start: 5, end: 5 }, GUID)).toThrow(FrameBridgeValidationError);
    expect(() => recutForRange(single(), { start: 9, end: 4 }, GUID)).toThrow(FrameBridgeValidationError);
  });

  test('a range past the end of the formatted text is refused rather than writing nothing', () => {
    expect(() => recutForRange(single(), { start: 40, end: 50 }, GUID)).toThrow(FrameBridgeValidationError);
  });
});

describe('rangeOfMatch', () => {
  const TITLE = ' Fusion Pilot Timeline: Key Milestones';

  test('finds a word and returns its character range', () => {
    expect(rangeOfMatch(TITLE, 'Timeline', 1)).toEqual({ start: 14, end: 22 });
    expect(TITLE.slice(14, 22)).toBe('Timeline');
  });

  test('counts occurrences the way a person does, from one', () => {
    expect(rangeOfMatch('ab ab ab', 'ab', 1)).toEqual({ start: 0, end: 2 });
    expect(rangeOfMatch('ab ab ab', 'ab', 2)).toEqual({ start: 3, end: 5 });
    expect(rangeOfMatch('ab ab ab', 'ab', 3)).toEqual({ start: 6, end: 8 });
  });

  test('finds overlapping occurrences', () => {
    expect(rangeOfMatch('aaa', 'aa', 2)).toEqual({ start: 1, end: 3 });
  });

  test('says the text is absent, quoting the paragraph, rather than formatting the wrong thing', () => {
    expect(() => rangeOfMatch(TITLE, 'Roadmap', 1)).toThrow(/does not appear/);
  });

  test('says how many times it did appear when the occurrence is out of reach', () => {
    expect(() => rangeOfMatch('ab ab', 'ab', 3)).toThrow(/appears 2 time/);
  });

  test('rejects an empty match or a non-positive occurrence', () => {
    expect(() => rangeOfMatch(TITLE, '', 1)).toThrow(FrameBridgeValidationError);
    expect(() => rangeOfMatch(TITLE, 'Timeline', 0)).toThrow(FrameBridgeValidationError);
  });
});
