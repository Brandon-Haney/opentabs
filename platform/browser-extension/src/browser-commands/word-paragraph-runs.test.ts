import { describe, expect, test } from 'vitest';
import { readProp } from './pods-model.js';
import { newParagraphProperties, paragraphIdFrom, replaceInParagraph } from './word-paragraph-runs.js';

const TEXT = 469769250;
const BOUNDARIES = 469769746;
const FORMATS = 603987475;
const FLAGS = 469769819;
const PROOFING = 469777855;

/** "The third paragraph closes the notes with next steps." with "next" in its own run, as captured. */
const threeRuns = (): (string | number)[] => [
  335559695,
  '1573849269',
  TEXT,
  'The third paragraph closes the notes with next steps.',
  FLAGS,
  '111',
  PROOFING,
  '010',
  BOUNDARIES,
  '42,46',
  FORMATS,
  '{a}{1},{b}{1},{c}{1}',
  469777513,
  '0,0,0',
];

const runsOf = (properties: (string | number)[]): string[] => {
  const text = readProp(properties, TEXT) ?? '';
  const boundaries = (readProp(properties, BOUNDARIES) ?? '').split(',').filter(Boolean).map(Number);
  const edges = [0, ...boundaries, text.length];
  return edges.slice(1).map((end, i) => text.slice(edges[i], end));
};

describe('replaceInParagraph', () => {
  test('shifts the boundaries after a match and leaves earlier ones alone', () => {
    const result = replaceInParagraph(threeRuns(), 'The third', 'The final');
    expect(result.count).toBe(1);
    expect(runsOf(result.properties)).toEqual(['The final paragraph closes the notes with ', 'next', ' steps.']);
    expect(readProp(result.properties, FORMATS)).toBe('{a}{1},{b}{1},{c}{1}');
  });

  test('a replacement covering a whole run takes that run’s formatting', () => {
    const result = replaceInParagraph(threeRuns(), 'next', 'upcoming');
    expect(runsOf(result.properties)).toEqual(['The third paragraph closes the notes with ', 'upcoming', ' steps.']);
  });

  test('drops a run the edit empties from every per-run array', () => {
    const result = replaceInParagraph(threeRuns(), 'next ', '');
    expect(runsOf(result.properties)).toEqual(['The third paragraph closes the notes with ', 'steps.']);
    expect(readProp(result.properties, FORMATS)).toBe('{a}{1},{c}{1}');
    expect(readProp(result.properties, FLAGS)).toBe('11');
    expect(readProp(result.properties, PROOFING)).toBe('00');
    expect(readProp(result.properties, 469777513)).toBe('0,0');
  });

  test('a match spanning runs takes the formatting of the run it starts in', () => {
    const result = replaceInParagraph(threeRuns(), 'with next', 'with the');
    expect(runsOf(result.properties)).toEqual(['The third paragraph closes the notes with the', ' steps.']);
    expect(readProp(result.properties, FORMATS)).toBe('{a}{1},{c}{1}');
  });

  test('replaces every occurrence, right to left, keeping offsets valid', () => {
    const result = replaceInParagraph(threeRuns(), 'e', 'EE');
    expect(result.count).toBe(6);
    expect(runsOf(result.properties)[1]).toBe('nEExt');
  });

  test('a paragraph emptied entirely keeps one run', () => {
    const result = replaceInParagraph(threeRuns(), 'The third paragraph closes the notes with next steps.', '');
    expect(readProp(result.properties, TEXT)).toBe('');
    expect(readProp(result.properties, BOUNDARIES)).toBeUndefined();
    expect(readProp(result.properties, FORMATS)).toBe('{a}{1}');
  });

  test('reports no change when the text is absent', () => {
    const properties = threeRuns();
    const result = replaceInParagraph(properties, 'absent', 'x');
    expect(result.count).toBe(0);
    expect(result.properties).toBe(properties);
  });
});

describe('newParagraphProperties', () => {
  test('copies paragraph formatting and reduces the runs to the longest one', () => {
    const properties = newParagraphProperties(
      [...threeRuns(), 536884268, '{style}{1}', 335551866, '1790869266091', 335559959, '1'],
      'A new line.',
      11,
      22,
    );
    expect(readProp(properties, TEXT)).toBe('A new line.');
    expect(readProp(properties, BOUNDARIES)).toBeUndefined();
    expect(readProp(properties, FORMATS)).toBe('{a}{1}');
    expect(readProp(properties, FLAGS)).toBe('1');
    expect(readProp(properties, PROOFING)).toBe('0');
    expect(readProp(properties, 536884268)).toBe('{style}{1}');
    expect(readProp(properties, 335559695)).toBe('11');
    expect(readProp(properties, 335559959)).toBe('22');
    expect(readProp(properties, 335551866)).toBeUndefined();
  });
});

describe('paragraphIdFrom', () => {
  test('is deterministic per seed and slot and stays a positive 31-bit value', () => {
    const id = paragraphIdFrom('seed', 4);
    expect(paragraphIdFrom('seed', 4)).toBe(id);
    expect(paragraphIdFrom('seed', 6)).not.toBe(id);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(0x80000000);
  });
});
