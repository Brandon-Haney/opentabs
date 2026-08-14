import { describe, expect, it } from 'vitest';
import { fitFontSize } from './text-metrics.js';

/** A body placeholder on a 16:9 slide, which is what most of these measure against. */
const BODY_WIDTH_IN = 11.5;
const BODY_HEIGHT_IN = 3.2;

describe('fitFontSize', () => {
  it('keeps the requested size when the text already fits', () => {
    const result = fitFontSize('Fusion pilot on track', BODY_WIDTH_IN, BODY_HEIGHT_IN, 28);
    expect(result.fontSizePt).toBe(28);
    expect(result.fits).toBe(true);
  });

  it('never returns a size above the ceiling, however much room is left', () => {
    // The ceiling carries the deck's design intent — the size the layout would
    // have used. Filling the box instead would silently restyle the slide.
    const result = fitFontSize('Short', BODY_WIDTH_IN, BODY_HEIGHT_IN, 18);
    expect(result.fontSizePt).toBe(18);
  });

  it('shrinks until the text fits rather than overflowing', () => {
    const fiveBullets = [
      'Inventory conversion accuracy held at 99.63%, with $5.5K variance on $1.5M of inventory',
      'Pick creation completing in 30-90 seconds against a 2-minute SLA',
      'Receiving remains the largest efficiency gap; exception handling drives the 1.7/4 sentiment score',
      'Invoice printing at 2-5 minutes per pick continues to delay counter staff and drivers',
      'Locators land the week of 8/31, unblocking cycle-count testing and labor measurement',
    ].join('\n');

    const result = fitFontSize(fiveBullets, BODY_WIDTH_IN, BODY_HEIGHT_IN, 40, 10, {
      indentIn: 0.3,
      paragraphSpacing: 0.3,
    });

    expect(result.fits).toBe(true);
    expect(result.fontSizePt).toBeLessThan(40);
    expect(result.estimatedHeightIn).toBeLessThanOrEqual(BODY_HEIGHT_IN);
  });

  it('reports failure instead of overflowing when even the floor is too big', () => {
    const wall = 'Fusion pilot status detail. '.repeat(200);
    const result = fitFontSize(wall, 4, 1, 28, 10);
    expect(result.fits).toBe(false);
    expect(result.fontSizePt).toBe(10);
  });

  it('caps the floor at the ceiling when a caller inverts them', () => {
    // Returning the floor here would hand back a size above the stated maximum,
    // which is the one outcome the maximum exists to prevent.
    const result = fitFontSize('x'.repeat(5000), BODY_WIDTH_IN, 0.4, 12, 24);
    expect(result.fontSizePt).toBeLessThanOrEqual(12);
  });

  it('counts a blank line as a line, so spacing is not measured away', () => {
    const spaced = fitFontSize('one\n\ntwo', BODY_WIDTH_IN, BODY_HEIGHT_IN, 28);
    const packed = fitFontSize('one\ntwo', BODY_WIDTH_IN, BODY_HEIGHT_IN, 28);
    expect(spaced.estimatedHeightIn).toBeGreaterThan(packed.estimatedHeightIn);
  });

  it('never fits a wide face at a larger size than a narrow one', () => {
    // Stated as a property across box heights rather than as one measurement:
    // at any given height the two faces often settle on the same size, and the
    // claim worth pinning is that the wider face is never given more room.
    const text = 'Receiving remains the largest efficiency gap for the Douglasville pilot team';
    const sizeFor = (font: string, heightIn: number) => fitFontSize(text, 3, heightIn, 28, 6, { font }).fontSizePt;

    const heights = [0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 3.0];
    const strictlySmaller = heights.filter(h => sizeFor('Verdana', h) < sizeFor('Calibri', h));

    for (const h of heights) {
      expect(sizeFor('Verdana', h)).toBeLessThanOrEqual(sizeFor('Calibri', h));
    }
    // If the table were never consulted the two would agree everywhere.
    expect(strictlySmaller.length).toBeGreaterThan(0);
  });

  it('treats an unknown face as the default rather than failing', () => {
    const unknown = fitFontSize('Fusion milestones', BODY_WIDTH_IN, BODY_HEIGHT_IN, 24, 10, { font: 'Nonesuch MS' });
    const unspecified = fitFontSize('Fusion milestones', BODY_WIDTH_IN, BODY_HEIGHT_IN, 24);
    expect(unknown.estimatedHeightIn).toBe(unspecified.estimatedHeightIn);
  });

  it('declares failure rather than dividing by a box narrower than its insets', () => {
    const result = fitFontSize('anything', 0.1, BODY_HEIGHT_IN, 18);
    expect(result.fits).toBe(false);
  });
});
