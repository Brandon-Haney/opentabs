import { describe, expect, it } from 'vitest';
import { addTableToSlide } from './slide-edit.js';
import { childByLocalName, childElements, descendantsByLocalName, parseXml } from './xml.js';

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** A slide with an empty shape tree, the substrate a table is appended to. */
const SLIDE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="${A_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>`;

/** Parse the emitted slide and return its single `<a:tbl>`. */
const tableOf = (xml: string): Element => {
  const tbl = descendantsByLocalName(parseXml(xml), 'tbl')[0];
  if (!tbl) throw new Error('no table emitted');
  return tbl;
};

const EMU_PER_INCH = 914400;

describe('addTableToSlide', () => {
  it('emits one gridCol per column and one tc per column in every row', () => {
    // A row whose cell count disagrees with the grid makes PowerPoint offer to
    // repair the file — so this is the invariant that matters most.
    const { xml } = addTableToSlide(SLIDE, {
      x: 1,
      y: 1,
      w: 6,
      h: 2,
      data: [
        ['Region', 'Q1', 'Q2'],
        ['West', '99', '101'],
      ],
    });
    const tbl = tableOf(xml);
    const gridCols = descendantsByLocalName(childByLocalName(tbl, 'tblGrid') as Element, 'gridCol');
    expect(gridCols).toHaveLength(3);
    for (const tr of childElements(tbl).filter(c => c.localName === 'tr')) {
      expect(childElements(tr).filter(c => c.localName === 'tc')).toHaveLength(3);
    }
  });

  it('pads a ragged row to the widest row rather than emitting a short row', () => {
    const { xml } = addTableToSlide(SLIDE, {
      x: 0,
      y: 0,
      w: 4,
      h: 1,
      data: [['a', 'b', 'c'], ['only one']],
    });
    const tbl = tableOf(xml);
    const rows = childElements(tbl).filter(c => c.localName === 'tr');
    expect(childElements(rows[1] as Element).filter(c => c.localName === 'tc')).toHaveLength(3);
  });

  it('makes column widths sum exactly to the frame width', () => {
    // PowerPoint rewrites the geometry on save unless sum(gridCol) == ext.cx to
    // the EMU, and then read-back coordinates would not match the request.
    const { xml } = addTableToSlide(SLIDE, { x: 0, y: 0, w: 7, h: 3, data: [['a', 'b', 'c']] });
    const tbl = tableOf(xml);
    const widths = descendantsByLocalName(childByLocalName(tbl, 'tblGrid') as Element, 'gridCol').map(g =>
      Number(g.getAttribute('w')),
    );
    const ext = descendantsByLocalName(parseXml(xml), 'ext')[0] as Element;
    expect(widths.reduce((a, b) => a + b, 0)).toBe(Number(ext.getAttribute('cx')));
    expect(widths.reduce((a, b) => a + b, 0)).toBe(7 * EMU_PER_INCH);
  });

  it('gives an empty cell a valid single-paragraph body', () => {
    // CT_TextBody requires bodyPr and at least one paragraph, or the part is invalid.
    const { xml } = addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [['', '']] });
    const tc = descendantsByLocalName(tableOf(xml), 'tc')[0] as Element;
    const txBody = childByLocalName(tc, 'txBody') as Element;
    expect(txBody.namespaceURI).toBe(A_NS);
    expect(childByLocalName(txBody, 'bodyPr')).toBeDefined();
    expect(childElements(txBody).filter(c => c.localName === 'p')).toHaveLength(1);
  });

  it('orders the cell children txBody then tcPr', () => {
    const { xml } = addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [['x']] });
    const tc = descendantsByLocalName(tableOf(xml), 'tc')[0] as Element;
    const kids = childElements(tc).map(c => c.localName);
    expect(kids).toEqual(['txBody', 'tcPr']);
  });

  it('references a built-in style GUID by default and needs no tableStyles part', () => {
    const { xml } = addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [['x']] });
    const styleId = descendantsByLocalName(tableOf(xml), 'tableStyleId')[0];
    expect(styleId?.textContent).toBe('{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}');
  });

  it('omits tblPr entirely for style "none"', () => {
    const { xml } = addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [['x']], style: 'none' });
    expect(childByLocalName(tableOf(xml), 'tblPr')).toBeUndefined();
  });

  it('passes a literal GUID through unchanged', () => {
    const guid = '{5940675A-B579-460E-94D1-54222C63F5DA}';
    const { xml } = addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [['x']], style: guid });
    expect(descendantsByLocalName(tableOf(xml), 'tableStyleId')[0]?.textContent).toBe(guid);
  });

  it('builds the frame with the three required children in order', () => {
    const { xml } = addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [['x']] });
    const frame = descendantsByLocalName(parseXml(xml), 'graphicFrame')[0] as Element;
    expect(childElements(frame).map(c => c.localName)).toEqual(['nvGraphicFramePr', 'xfrm', 'graphic']);
    // xfrm is PresentationML; its off/ext are DrawingML.
    const xfrm = childByLocalName(frame, 'xfrm') as Element;
    expect(xfrm.namespaceURI).toBe(P_NS);
    expect((childByLocalName(xfrm, 'off') as Element).namespaceURI).toBe(A_NS);
  });

  it('rejects an empty data grid', () => {
    expect(() => addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [] })).toThrow(/at least one row/);
    expect(() => addTableToSlide(SLIDE, { x: 0, y: 0, w: 2, h: 1, data: [[]] })).toThrow(/at least one column/);
  });
});
