import { describe, expect, it } from 'vitest';
import { findSlot, readLayoutSlots, resolveSlots, roleForPlaceholderType } from './placeholders.js';
import type { ShapeNode } from './slide-layout.js';

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** A layout part whose shape tree holds the given `<p:sp>` fragments. */
const layout = (shapes: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sldLayout xmlns:a="${A_NS}" xmlns:p="${P_NS}"><p:cSld name="Two Content"><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  `${shapes}</p:spTree></p:cSld></p:sldLayout>`;

/** One placeholder shape in a layout. */
const ph = (attrs: string, id = 2): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="ph${id}"/><p:cNvSpPr/>` +
  `<p:nvPr><p:ph ${attrs}/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`;

const shape = (over: Partial<ShapeNode>): ShapeNode => ({
  id: '2',
  name: 'Title 1',
  kind: 'placeholder',
  x: 0,
  y: 0,
  w: 10,
  h: 1,
  ...over,
});

describe('roleForPlaceholderType', () => {
  it("treats a title slide's centred title as a title", () => {
    expect(roleForPlaceholderType('ctrTitle')).toBe('title');
  });

  it('treats an untyped placeholder as body, which is the schema default', () => {
    expect(roleForPlaceholderType('')).toBe('body');
  });

  it('treats a content placeholder as body', () => {
    expect(roleForPlaceholderType('obj')).toBe('body');
  });

  it('gives date, footer and slide-number furniture no role', () => {
    // These render from the layout and master; copying them onto a slide
    // produces empty duplicates over the real ones.
    for (const type of ['dt', 'ftr', 'sldNum']) {
      expect(roleForPlaceholderType(type)).toBeUndefined();
    }
  });
});

describe('readLayoutSlots', () => {
  it('reads type, idx, sz and orient from each slot', () => {
    const slots = readLayoutSlots(layout(ph('type="body" idx="1" sz="half" orient="vert"')));
    expect(slots).toEqual([{ type: 'body', idx: 1, sz: 'half', orient: 'vert' }]);
  });

  it('defaults a missing idx to 0, which is how a title is stored', () => {
    expect(readLayoutSlots(layout(ph('type="title"')))[0]?.idx).toBe(0);
  });

  it('keeps two body placeholders that differ only by idx', () => {
    const slots = readLayoutSlots(layout(ph('type="body" idx="1"', 2) + ph('type="body" idx="2"', 3)));
    expect(slots.map(s => s.idx)).toEqual([1, 2]);
  });

  it('drops footer furniture', () => {
    const slots = readLayoutSlots(layout(ph('type="title"', 2) + ph('type="ftr" idx="10"', 3)));
    expect(slots.map(s => s.type)).toEqual(['title']);
  });

  it('ignores a duplicated index rather than emitting two slots with one identity', () => {
    const slots = readLayoutSlots(layout(ph('type="body" idx="1"', 2) + ph('type="obj" idx="1"', 3)));
    expect(slots).toHaveLength(1);
  });
});

describe('resolveSlots', () => {
  it('reports a layout slot the slide never filled, with a null shape id', () => {
    // PowerPoint shows these as "Click to add title" — omitting them would
    // report a slide as having no title when it simply has an untouched one.
    const slots = resolveSlots([], [{ type: 'title', idx: 0, sz: null, orient: null }]);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ role: 'title', idx: 0, shape_id: null, text: '' });
  });

  it("prefers the slide's own shape over the layout's empty slot", () => {
    const slots = resolveSlots(
      [shape({ id: '7', placeholder_type: 'title', placeholder_idx: 0 })],
      [{ type: 'title', idx: 0, sz: null, orient: null }],
    );
    expect(slots).toHaveLength(1);
    expect(slots[0]?.shape_id).toBe('7');
  });

  it('orders slots by index', () => {
    const slots = resolveSlots(
      [
        shape({ id: '3', placeholder_type: 'body', placeholder_idx: 2 }),
        shape({ id: '2', placeholder_type: 'title', placeholder_idx: 0 }),
      ],
      [],
    );
    expect(slots.map(s => s.idx)).toEqual([0, 2]);
  });

  it('ignores non-placeholder shapes', () => {
    expect(resolveSlots([shape({ id: '9', kind: 'textbox' })], [])).toHaveLength(0);
  });
});

describe('findSlot', () => {
  const twoBodies = resolveSlots(
    [
      shape({ id: '3', placeholder_type: 'body', placeholder_idx: 1 }),
      shape({ id: '4', placeholder_type: 'body', placeholder_idx: 2 }),
    ],
    [],
  );

  it('refuses to guess between two slots of the same role', () => {
    // Picking the first would quietly write to whichever came first in
    // document order — the exact bug idx exists to prevent.
    expect(() => findSlot(twoBodies, 'body')).toThrow(/idx 1, 2/);
  });

  it('resolves the ambiguity when given an index', () => {
    expect(findSlot(twoBodies, 'body', 2).shape_id).toBe('4');
  });

  it('names the available slots when the requested role is absent', () => {
    expect(() => findSlot(twoBodies, 'title')).toThrow(/no title placeholder/);
  });

  it('reports the index when a specific one was asked for and is missing', () => {
    expect(() => findSlot(twoBodies, 'body', 9)).toThrow(/idx 9/);
  });
});
