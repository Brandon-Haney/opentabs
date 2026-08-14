import { describe, expect, it } from 'vitest';
import { isSlideHidden, setSlideHidden } from './slide-edit.js';

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** A minimal slide part, optionally carrying a `show` attribute. */
const slide = (showAttr = ''): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sld xmlns:a="${A_NS}" xmlns:p="${P_NS}"${showAttr}>` +
  `<p:cSld><p:spTree/></p:cSld></p:sld>`;

describe('slide visibility', () => {
  it('reads a slide with no show attribute as visible', () => {
    // `show` defaults to true, and nearly every slide omits it — reading its
    // absence as hidden would report an entire deck as suppressed.
    expect(isSlideHidden(slide())).toBe(false);
  });

  it('reads show="0" as hidden', () => {
    expect(isSlideHidden(slide(' show="0"'))).toBe(true);
  });

  it('reads the boolean spelling as hidden too', () => {
    // ST_Boolean permits "false" as well as "0", and producers differ.
    expect(isSlideHidden(slide(' show="false"'))).toBe(true);
  });

  it('reads show="1" as visible', () => {
    expect(isSlideHidden(slide(' show="1"'))).toBe(false);
  });

  it('hides a visible slide', () => {
    expect(isSlideHidden(setSlideHidden(slide(), true))).toBe(true);
  });

  it('restores a hidden slide', () => {
    expect(isSlideHidden(setSlideHidden(slide(' show="0"'), false))).toBe(false);
  });

  it('removes the attribute when restoring rather than writing show="1"', () => {
    // True is the schema default and PowerPoint omits it; writing it back would
    // leave a fingerprint on every slide this ever touched.
    expect(setSlideHidden(slide(' show="0"'), false)).not.toContain('show=');
  });

  it('round-trips through hide and restore', () => {
    const hidden = setSlideHidden(slide(), true);
    expect(isSlideHidden(setSlideHidden(hidden, false))).toBe(false);
  });
});
