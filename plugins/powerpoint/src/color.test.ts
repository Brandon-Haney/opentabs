import { describe, expect, it } from 'vitest';
import { buildColorElement } from './color.js';
import { A_NS, childElements, parseXml } from './xml.js';

const doc = () => parseXml('<root/>');

const build = (input: string): Element => buildColorElement(doc(), input, 'fill');

describe('buildColorElement', () => {
  it('writes a hex literal as an srgbClr in the DrawingML namespace', () => {
    const el = build('FFCC00');
    expect(el.localName).toBe('srgbClr');
    expect(el.namespaceURI).toBe(A_NS);
    expect(el.getAttribute('val')).toBe('FFCC00');
  });

  it('accepts a leading hash and normalises case', () => {
    expect(build('#ffcc00').getAttribute('val')).toBe('FFCC00');
  });

  it('writes a theme name as a schemeClr, so it follows the deck template', () => {
    const el = build('accent1');
    expect(el.localName).toBe('schemeClr');
    expect(el.getAttribute('val')).toBe('accent1');
  });

  it('round-trips the "scheme:" form that get_slide_layout reports', () => {
    expect(build('scheme:accent2').getAttribute('val')).toBe('accent2');
  });

  it('matches theme names case-insensitively but writes the schema spelling', () => {
    expect(build('folhlink').getAttribute('val')).toBe('folHlink');
  });

  it('expresses a tint as the lumMod/lumOff pair PowerPoint uses, in that order', () => {
    const el = build('accent1 lighter 40%');
    expect(el.localName).toBe('schemeClr');
    expect(childElements(el).map(c => [c.localName, c.getAttribute('val')])).toEqual([
      ['lumMod', '60000'],
      ['lumOff', '40000'],
    ]);
  });

  it('leaves a plain theme colour with no luminance children', () => {
    expect(childElements(build('accent1'))).toHaveLength(0);
  });

  it('rejects a colour name that is neither hex nor a theme slot', () => {
    // "red" would otherwise reach a:srgbClr/@val, which is xsd:hexBinary —
    // PowerPoint reports the file as damaged and repairs by dropping the slide.
    expect(() => build('red')).toThrow(/Invalid fill color/);
  });

  it('rejects a three-digit hex, which OOXML does not accept', () => {
    expect(() => build('#fc0')).toThrow(/Invalid fill color/);
  });

  it('rejects a tint percentage outside the usable range', () => {
    expect(() => build('accent1 lighter 0%')).toThrow(/1–99%/);
    expect(() => build('accent1 lighter 100%')).toThrow(/1–99%/);
  });
});
