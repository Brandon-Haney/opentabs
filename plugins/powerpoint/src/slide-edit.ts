/**
 * Slide XML mutation helpers for Phase 2 editing tools.
 *
 * Each operation takes a slide XML string, locates a target shape by its
 * `cNvPr@id`, mutates the OOXML DOM in place, and returns the serialized
 * result. Units coming in are inches / degrees; conversion to EMUs happens
 * here.
 *
 * Design choices:
 * - Edits preserve existing formatting wherever possible (text edits keep
 *   the first run's rPr; geometry edits only touch xfrm attributes).
 * - Fill edits replace any existing fill (solid/gradient/blip/pattern) with
 *   a solid fill — simpler and matches typical agent intent.
 * - Duplicate reassigns cNvPr ids throughout the cloned subtree to avoid
 *   collisions and applies a small offset so the copy is visible.
 */

import { ToolError } from '@opentabs-dev/plugin-sdk';
import { buildSolidFill } from './color.js';
import { appendPlaceholder, type PlaceholderSpec, readLayoutSlots } from './placeholders.js';
import {
  getNotesForSlide,
  getRelatedParts,
  getSlideList,
  relsPathFor,
  resolveRelTarget,
  TEXT_DECODER,
  TEXT_ENCODER,
} from './pptx-utils.js';
import {
  A_NS,
  CT_NS,
  childByLocalName,
  childElements,
  isElement,
  P_NS,
  PKG_REL_NS,
  parseXml,
  R_NS,
  serializeXml,
} from './xml.js';

// --- Units ---

const EMU_PER_INCH = 914400;
/** Rotation in OOXML is stored as 60,000ths of a degree. */
const ROT_UNITS_PER_DEG = 60000;

const inchesToEmu = (inches: number): number => Math.round(inches * EMU_PER_INCH);
const degreesToRotUnits = (deg: number): number => Math.round(deg * ROT_UNITS_PER_DEG);

/** Return the nvProps container for any shape kind. */
const getNvProps = (shape: Element): Element | undefined =>
  childByLocalName(shape, 'nvSpPr') ??
  childByLocalName(shape, 'nvPicPr') ??
  childByLocalName(shape, 'nvCxnSpPr') ??
  childByLocalName(shape, 'nvGraphicFramePr') ??
  childByLocalName(shape, 'nvGrpSpPr');

/** Get the shape's user-visible id from `cNvPr@id`. */
const getShapeId = (shape: Element): string | undefined => {
  const nv = getNvProps(shape);
  const cNvPr = nv ? childByLocalName(nv, 'cNvPr') : undefined;
  return cNvPr?.getAttribute('id') ?? undefined;
};

const SHAPE_LOCAL_NAMES = new Set(['sp', 'pic', 'cxnSp', 'graphicFrame', 'grpSp']);

/** Depth-first search for a top-level-or-nested shape element with matching id. */
const findShapeById = (root: Node, shapeId: string): Element | undefined => {
  const doc = (root as Document).ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && SHAPE_LOCAL_NAMES.has(node.localName) && getShapeId(node) === shapeId) {
      return node;
    }
    node = walker.nextNode();
  }
  return undefined;
};

// --- Geometry helpers ---

/**
 * Return the shape's xfrm element, creating one in the correct position if
 * missing. Handles the two OOXML conventions:
 * - sp/pic/cxnSp have `spPr > a:xfrm`
 * - grpSp has `grpSpPr > a:xfrm`
 * - graphicFrame has `p:xfrm` as a direct child
 */
const findOrCreateXfrm = (shape: Element): Element => {
  const doc = shape.ownerDocument;
  if (!doc) throw ToolError.internal('Shape element has no owner document');
  const ln = shape.localName;

  if (ln === 'graphicFrame') {
    const existing = childByLocalName(shape, 'xfrm');
    if (existing) return existing;
    const xfrm = doc.createElementNS(P_NS, 'p:xfrm');
    // Insert after nvGraphicFramePr per schema order
    const nv = childByLocalName(shape, 'nvGraphicFramePr');
    if (nv?.nextSibling) shape.insertBefore(xfrm, nv.nextSibling);
    else shape.appendChild(xfrm);
    return xfrm;
  }

  let container: Element | undefined;
  if (ln === 'grpSp') container = childByLocalName(shape, 'grpSpPr');
  else container = childByLocalName(shape, 'spPr');
  if (!container) throw ToolError.internal(`Shape ${ln} missing spPr/grpSpPr`);

  const existing = childByLocalName(container, 'xfrm');
  if (existing) return existing;
  const xfrm = doc.createElementNS(A_NS, 'a:xfrm');
  // xfrm must come first inside spPr per OOXML schema
  container.insertBefore(xfrm, container.firstChild);
  return xfrm;
};

/** Get or create `<a:off>` inside the xfrm, preserving schema order (off before ext). */
const findOrCreateOff = (xfrm: Element): Element => {
  const existing = childByLocalName(xfrm, 'off');
  if (existing) return existing;
  const doc = xfrm.ownerDocument;
  if (!doc) throw ToolError.internal('xfrm has no owner document');
  const off = doc.createElementNS(A_NS, 'a:off');
  off.setAttribute('x', '0');
  off.setAttribute('y', '0');
  const ext = childByLocalName(xfrm, 'ext');
  if (ext) xfrm.insertBefore(off, ext);
  else xfrm.appendChild(off);
  return off;
};

/** Get or create `<a:ext>` inside the xfrm. */
const findOrCreateExt = (xfrm: Element): Element => {
  const existing = childByLocalName(xfrm, 'ext');
  if (existing) return existing;
  const doc = xfrm.ownerDocument;
  if (!doc) throw ToolError.internal('xfrm has no owner document');
  const ext = doc.createElementNS(A_NS, 'a:ext');
  ext.setAttribute('cx', '0');
  ext.setAttribute('cy', '0');
  xfrm.appendChild(ext);
  return ext;
};

// --- Edit operations ---

export interface GeometryEdit {
  /** New X in inches. Omit to leave unchanged. */
  x?: number;
  /** New Y in inches. */
  y?: number;
  /** New width in inches. */
  w?: number;
  /** New height in inches. */
  h?: number;
  /** New rotation in degrees (clockwise). */
  rotation?: number;
}

/** Update a shape's position, size, and/or rotation. */
export const editShapeGeometry = (slideXml: string, shapeId: string, edit: GeometryEdit): string => {
  const doc = parseXml(slideXml);
  const shape = findShapeById(doc, shapeId);
  if (!shape) throw ToolError.notFound(`Shape ${shapeId} not found on slide`);

  const xfrm = findOrCreateXfrm(shape);

  if (edit.rotation !== undefined) {
    xfrm.setAttribute('rot', String(degreesToRotUnits(edit.rotation)));
  }

  if (edit.x !== undefined || edit.y !== undefined) {
    const off = findOrCreateOff(xfrm);
    if (edit.x !== undefined) off.setAttribute('x', String(inchesToEmu(edit.x)));
    if (edit.y !== undefined) off.setAttribute('y', String(inchesToEmu(edit.y)));
  }

  if (edit.w !== undefined || edit.h !== undefined) {
    const ext = findOrCreateExt(xfrm);
    if (edit.w !== undefined) ext.setAttribute('cx', String(inchesToEmu(edit.w)));
    if (edit.h !== undefined) ext.setAttribute('cy', String(inchesToEmu(edit.h)));
  }

  return serializeXml(doc);
};

/** Replace a shape's fill with a solid color — a hex literal or a theme slot. */
export const editShapeFill = (slideXml: string, shapeId: string, color: string): string => {
  const doc = parseXml(slideXml);
  const shape = findShapeById(doc, shapeId);
  if (!shape) throw ToolError.notFound(`Shape ${shapeId} not found on slide`);
  if (shape.localName === 'pic') {
    throw ToolError.validation('Cannot set fill color on a picture shape');
  }

  const spPr = childByLocalName(shape, 'spPr') ?? childByLocalName(shape, 'grpSpPr');
  if (!spPr) throw ToolError.internal('Shape has no spPr');

  // Built before anything is removed, so an invalid colour leaves the shape
  // exactly as it was rather than stripping its fill on the way to failing.
  const solidFill = buildSolidFill(doc, color, 'fill');

  // Remove any existing fill elements to keep the shape in a consistent state.
  for (const tag of ['solidFill', 'gradFill', 'blipFill', 'pattFill', 'noFill']) {
    const existing = childByLocalName(spPr, tag);
    if (existing) spPr.removeChild(existing);
  }

  // Schema order: xfrm, custGeom/prstGeom, fill, ln, ...
  // Insert fill after geometry if present, else after xfrm, else at end.
  const geom = childByLocalName(spPr, 'prstGeom') ?? childByLocalName(spPr, 'custGeom');
  const xfrm = childByLocalName(spPr, 'xfrm');
  const anchor = geom ?? xfrm;
  if (anchor?.nextSibling) spPr.insertBefore(solidFill, anchor.nextSibling);
  else spPr.appendChild(solidFill);

  return serializeXml(doc);
};

/** Deepest outline level OOXML allows: `ST_TextIndentLevelType` is 0–8. */
const MAX_OUTLINE_LEVEL = 8;

/** One paragraph of an outline, with the level its leading tabs asked for. */
export interface OutlineParagraph {
  text: string;
  level: number;
}

/**
 * Split text into paragraphs, reading leading tabs as outline levels.
 *
 * A tab is what a person presses to demote a bullet, so it is what the tools
 * take: one tab is the second level, two the third. Prose never begins with a
 * tab, so text that uses none is simply flat — the behaviour every existing
 * caller already relies on.
 */
export const parseOutline = (text: string): OutlineParagraph[] =>
  text.split('\n').map(line => {
    const stripped = line.replace(/^\t+/, '');
    return {
      text: stripped,
      level: Math.min(line.length - stripped.length, MAX_OUTLINE_LEVEL),
    };
  });

/**
 * Build the `<a:pPr>` for one outline paragraph.
 *
 * Carries `lvl` and nothing else. Indent, bullet glyph, and per-level size all
 * resolve up the cascade to the layout and master, and stating any of them here
 * would *win* over that cascade — freezing the list against the deck's own
 * styling and, in practice, rendering every level flat. The preserved `pPr` is
 * therefore consulted only for alignment, which has no level-specific default
 * to conflict with.
 */
const buildOutlinePPr = (doc: Document, level: number, preserved: Element | null): Element => {
  const pPr = doc.createElementNS(A_NS, 'a:pPr');
  // Level 0 is the schema default and PowerPoint omits it.
  if (level > 0) pPr.setAttribute('lvl', String(level));
  const algn = preserved?.getAttribute('algn');
  if (algn) pPr.setAttribute('algn', algn);
  return pPr;
};

/**
 * Replace the text content of a shape's text body. Preserves the first
 * paragraph's pPr and the first run's rPr so existing formatting carries
 * over to the new text. Newlines split into separate paragraphs, and leading
 * tabs demote a paragraph to a deeper outline level.
 */
export const editShapeText = (slideXml: string, shapeId: string, newText: string, format?: TextFormatEdit): string => {
  const doc = parseXml(slideXml);
  const shape = findShapeById(doc, shapeId);
  if (!shape) throw ToolError.notFound(`Shape ${shapeId} not found on slide`);

  const txBody = childByLocalName(shape, 'txBody');
  if (!txBody) {
    throw ToolError.validation(`Shape ${shapeId} (${shape.localName}) does not have a text body`);
  }

  // Preserve formatting templates from the first existing paragraph/run.
  let preservedPPr: Element | null = null;
  let preservedRPr: Element | null = null;
  const firstP = childByLocalName(txBody, 'p');
  if (firstP) {
    const pPr = childByLocalName(firstP, 'pPr');
    if (pPr) preservedPPr = pPr.cloneNode(true) as Element;
    const firstR = childByLocalName(firstP, 'r');
    if (firstR) {
      const rPr = childByLocalName(firstR, 'rPr');
      if (rPr) preservedRPr = rPr.cloneNode(true) as Element;
    }
  }

  // Remove all existing paragraphs.
  for (const p of childElements(txBody).filter(c => c.localName === 'p')) {
    txBody.removeChild(p);
  }

  const paragraphs = parseOutline(newText);
  // Only text that actually asks for levels gets a rebuilt `pPr`. Without that
  // gate, rewriting a shape's text would silently discard a bullet glyph or
  // indent a person had set by hand on the paragraph we cloned from.
  const hasLevels = paragraphs.some(p => p.level > 0);

  for (const paragraph of paragraphs) {
    const p = doc.createElementNS(A_NS, 'a:p');
    if (hasLevels) p.appendChild(buildOutlinePPr(doc, paragraph.level, preservedPPr));
    else if (preservedPPr) p.appendChild(preservedPPr.cloneNode(true));

    const r = doc.createElementNS(A_NS, 'a:r');
    if (preservedRPr) r.appendChild(preservedRPr.cloneNode(true));
    if (format) applyRunFormat(doc, r, format);

    const t = doc.createElementNS(A_NS, 'a:t');
    t.textContent = paragraph.text;
    r.appendChild(t);
    p.appendChild(r);
    txBody.appendChild(p);
  }

  return serializeXml(doc);
};

/**
 * Apply run formatting to every run already in a shape, leaving the text alone.
 *
 * Resizing text is the remedy for a box that overflows, and that has to be
 * reachable without rewriting the content — otherwise a caller has to know the
 * existing text just to change its size.
 */
export const formatShapeText = (slideXml: string, shapeId: string, format: TextFormatEdit): string => {
  const doc = parseXml(slideXml);
  const shape = findShapeById(doc, shapeId);
  if (!shape) throw ToolError.notFound(`Shape ${shapeId} not found on slide`);

  const txBody = childByLocalName(shape, 'txBody');
  if (!txBody) throw ToolError.validation(`Shape ${shapeId} (${shape.localName}) does not have a text body`);

  let runCount = 0;
  for (const p of childElements(txBody).filter(c => c.localName === 'p')) {
    for (const r of childElements(p).filter(c => c.localName === 'r')) {
      applyRunFormat(doc, r, format);
      runCount++;
    }
    // An empty paragraph carries its formatting on `endParaRPr`, so a size
    // applied there keeps blank lines in step with the rest of the text.
    const endParaRPr = childByLocalName(p, 'endParaRPr');
    if (endParaRPr && format.fontSize !== undefined) {
      endParaRPr.setAttribute('sz', String(Math.round(format.fontSize * 100)));
    }
  }
  if (runCount === 0) throw ToolError.validation(`Shape ${shapeId} has no text runs to format`);

  return serializeXml(doc);
};

/** Run-level text formatting applied on top of the preserved `rPr`. */
export interface TextFormatEdit {
  /** Font size in points. */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  /** Text color as hex, with or without a leading `#`. */
  color?: string;
}

/**
 * Apply run formatting to a run element, creating or amending its `<a:rPr>`.
 *
 * Amends rather than replaces: the run may already carry a preserved `rPr`
 * holding theme font and language, and only the requested attributes should
 * change. `sz` is in hundredths of a point.
 */
const applyRunFormat = (doc: Document, run: Element, format: TextFormatEdit): void => {
  // Built before the DOM is touched. An unvalidated colour would otherwise reach
  // `a:srgbClr/@val`, which is `xsd:hexBinary` — PowerPoint rejects the part and
  // offers to repair the file by discarding the slide, and by then the whole
  // package has already been PUT over the co-edited original.
  const fill = format.color === undefined ? undefined : buildSolidFill(doc, format.color, 'text');

  let rPr = childByLocalName(run, 'rPr');
  if (!rPr) {
    rPr = doc.createElementNS(A_NS, 'a:rPr');
    run.insertBefore(rPr, run.firstChild);
  }
  if (format.fontSize !== undefined) rPr.setAttribute('sz', String(Math.round(format.fontSize * 100)));
  if (format.bold !== undefined) rPr.setAttribute('b', format.bold ? '1' : '0');
  if (format.italic !== undefined) rPr.setAttribute('i', format.italic ? '1' : '0');
  if (fill) setRunFill(rPr, fill);
};

/** Fill kinds in `EG_FillProperties`, of which an `a:rPr` may carry at most one. */
const FILL_ELEMENTS = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'];

/**
 * Replace a run's fill with a solid colour, in the position the schema requires.
 *
 * `CT_TextCharacterProperties` is a sequence, and its fill group comes *after*
 * `a:ln` — the reverse of `CT_ShapeProperties`, where the fill precedes the
 * line. A run carrying a text outline is ordinary content (it is what
 * PowerPoint writes for outlined and WordArt text), so anchoring at the first
 * child would put the fill ahead of that outline and make the part invalid.
 * Any other fill kind is removed first, since the group permits only one.
 */
const setRunFill = (rPr: Element, solidFill: Element): void => {
  for (const existing of childElements(rPr).filter(c => FILL_ELEMENTS.includes(c.localName))) {
    rPr.removeChild(existing);
  }

  const ln = childByLocalName(rPr, 'ln');
  if (ln) rPr.insertBefore(solidFill, ln.nextSibling);
  else rPr.insertBefore(solidFill, rPr.firstChild);
};

/** Remove a shape from its parent (spTree or group). */
export const deleteShapeById = (slideXml: string, shapeId: string): string => {
  const doc = parseXml(slideXml);
  const shape = findShapeById(doc, shapeId);
  if (!shape) throw ToolError.notFound(`Shape ${shapeId} not found on slide`);

  const parent = shape.parentNode;
  if (!parent) throw ToolError.internal('Shape has no parent');
  parent.removeChild(shape);

  return serializeXml(doc);
};

/** Find the `<p:spTree>` element that holds all shapes on a slide. */
export const findSpTree = (doc: Document): Element | undefined => {
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === 'spTree') return node;
    node = walker.nextNode();
  }
  return undefined;
};

const ALIGN_MAP: Record<'left' | 'center' | 'right' | 'justify', string> = {
  left: 'l',
  center: 'ctr',
  right: 'r',
  justify: 'just',
};

export type TextAlign = 'left' | 'center' | 'right' | 'justify';

export interface TextFormatting {
  font_size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  font?: string;
  align?: TextAlign;
}

/** Build a minimal `<p:txBody>` containing the given text and formatting. */
const buildTxBody = (doc: Document, text: string, fmt: TextFormatting): Element => {
  const txBody = doc.createElementNS(P_NS, 'p:txBody');

  const bodyPr = doc.createElementNS(A_NS, 'a:bodyPr');
  bodyPr.setAttribute('wrap', 'square');
  bodyPr.setAttribute('rtlCol', '0');
  txBody.appendChild(bodyPr);

  const lstStyle = doc.createElementNS(A_NS, 'a:lstStyle');
  txBody.appendChild(lstStyle);

  const lines = text.length > 0 ? text.split('\n') : [''];
  for (const line of lines) {
    const p = doc.createElementNS(A_NS, 'a:p');

    if (fmt.align) {
      const pPr = doc.createElementNS(A_NS, 'a:pPr');
      pPr.setAttribute('algn', ALIGN_MAP[fmt.align]);
      p.appendChild(pPr);
    }

    if (line.length === 0) {
      // Empty paragraph — use endParaRPr so PowerPoint preserves the line.
      const endParaRPr = doc.createElementNS(A_NS, 'a:endParaRPr');
      endParaRPr.setAttribute('lang', 'en-US');
      endParaRPr.setAttribute('dirty', '0');
      p.appendChild(endParaRPr);
      txBody.appendChild(p);
      continue;
    }

    const r = doc.createElementNS(A_NS, 'a:r');
    const rPr = doc.createElementNS(A_NS, 'a:rPr');
    rPr.setAttribute('lang', 'en-US');
    rPr.setAttribute('dirty', '0');
    if (fmt.font_size !== undefined) rPr.setAttribute('sz', String(Math.round(fmt.font_size * 100)));
    if (fmt.bold) rPr.setAttribute('b', '1');
    if (fmt.italic) rPr.setAttribute('i', '1');
    if (fmt.color) rPr.appendChild(buildSolidFill(doc, fmt.color, 'text'));
    if (fmt.font) {
      const latin = doc.createElementNS(A_NS, 'a:latin');
      latin.setAttribute('typeface', fmt.font);
      rPr.appendChild(latin);
    }
    r.appendChild(rPr);

    const t = doc.createElementNS(A_NS, 'a:t');
    t.textContent = line;
    r.appendChild(t);
    p.appendChild(r);
    txBody.appendChild(p);
  }

  return txBody;
};

/** Build a scaffolding `<p:sp>` element — caller fills in spPr and txBody. */
const buildSpBase = (doc: Document, id: number, name: string, isTextBox: boolean): Element => {
  const sp = doc.createElementNS(P_NS, 'p:sp');

  const nvSpPr = doc.createElementNS(P_NS, 'p:nvSpPr');
  const cNvPr = doc.createElementNS(P_NS, 'p:cNvPr');
  cNvPr.setAttribute('id', String(id));
  cNvPr.setAttribute('name', name);
  nvSpPr.appendChild(cNvPr);

  const cNvSpPr = doc.createElementNS(P_NS, 'p:cNvSpPr');
  if (isTextBox) cNvSpPr.setAttribute('txBox', '1');
  nvSpPr.appendChild(cNvSpPr);

  const nvPr = doc.createElementNS(P_NS, 'p:nvPr');
  nvSpPr.appendChild(nvPr);
  sp.appendChild(nvSpPr);

  const spPr = doc.createElementNS(P_NS, 'p:spPr');
  sp.appendChild(spPr);
  return sp;
};

/** Populate an `spPr` with xfrm, prstGeom, and optional solid fill, in schema order. */
const populateSpPr = (
  spPr: Element,
  geom: { x: number; y: number; w: number; h: number; rotation?: number },
  preset: string,
  fill: string | undefined,
): void => {
  const doc = spPr.ownerDocument;
  if (!doc) throw ToolError.internal('spPr has no owner document');

  const xfrm = doc.createElementNS(A_NS, 'a:xfrm');
  if (geom.rotation !== undefined && geom.rotation !== 0) {
    xfrm.setAttribute('rot', String(degreesToRotUnits(geom.rotation)));
  }
  const off = doc.createElementNS(A_NS, 'a:off');
  off.setAttribute('x', String(inchesToEmu(geom.x)));
  off.setAttribute('y', String(inchesToEmu(geom.y)));
  xfrm.appendChild(off);
  const ext = doc.createElementNS(A_NS, 'a:ext');
  ext.setAttribute('cx', String(inchesToEmu(geom.w)));
  ext.setAttribute('cy', String(inchesToEmu(geom.h)));
  xfrm.appendChild(ext);
  spPr.appendChild(xfrm);

  const prstGeom = doc.createElementNS(A_NS, 'a:prstGeom');
  prstGeom.setAttribute('prst', preset);
  prstGeom.appendChild(doc.createElementNS(A_NS, 'a:avLst'));
  spPr.appendChild(prstGeom);

  if (fill !== undefined) spPr.appendChild(buildSolidFill(doc, fill, 'fill'));
};

/** Get the largest cNvPr id currently in use anywhere in the document. */
export const getMaxCNvPrId = (doc: Document): number => {
  let max = 0;
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === 'cNvPr') {
      const id = Number.parseInt(node.getAttribute('id') ?? '0', 10);
      if (Number.isFinite(id) && id > max) max = id;
    }
    node = walker.nextNode();
  }
  return max;
};

export interface DuplicateOptions {
  /** Offset in inches applied to the clone's position. Defaults to 0.25 x 0.25. */
  offset_x?: number;
  offset_y?: number;
}

/**
 * Duplicate a shape in place. Returns the modified XML and the new top-level
 * shape's id so the caller can target it with further edits.
 */
export const duplicateShapeById = (
  slideXml: string,
  shapeId: string,
  opts: DuplicateOptions = {},
): { xml: string; new_shape_id: string } => {
  const doc = parseXml(slideXml);
  const shape = findShapeById(doc, shapeId);
  if (!shape) throw ToolError.notFound(`Shape ${shapeId} not found on slide`);

  const clone = shape.cloneNode(true) as Element;

  // Reassign cNvPr ids throughout the clone to avoid collisions with the original.
  let nextId = getMaxCNvPrId(doc) + 1;
  const newTopId = String(nextId);
  const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === 'cNvPr') {
      node.setAttribute('id', String(nextId));
      nextId++;
    }
    node = walker.nextNode();
  }

  // Offset the clone so it's visibly distinct from the original.
  const offsetX = opts.offset_x ?? 0.25;
  const offsetY = opts.offset_y ?? 0.25;
  const xfrm = findOrCreateXfrm(clone);
  const off = findOrCreateOff(xfrm);
  const existingX = Number.parseInt(off.getAttribute('x') ?? '0', 10);
  const existingY = Number.parseInt(off.getAttribute('y') ?? '0', 10);
  off.setAttribute('x', String(existingX + inchesToEmu(offsetX)));
  off.setAttribute('y', String(existingY + inchesToEmu(offsetY)));

  // Insert immediately after the original so z-order places the copy on top.
  const parent = shape.parentNode;
  if (!parent) throw ToolError.internal('Shape has no parent');
  parent.insertBefore(clone, shape.nextSibling);

  return { xml: serializeXml(doc), new_shape_id: newTopId };
};

// --- Shape creation ---

export interface AddTextBoxOptions extends TextFormatting {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  rotation?: number;
  name?: string;
}

/**
 * Add a new text box to a slide. Returns the new shape's id so the caller
 * can chain an `update_shape` edit against it.
 */
export const addTextBox = (slideXml: string, opts: AddTextBoxOptions): { xml: string; new_shape_id: string } => {
  const doc = parseXml(slideXml);
  const spTree = findSpTree(doc);
  if (!spTree) throw ToolError.internal('Slide has no spTree');

  const id = getMaxCNvPrId(doc) + 1;
  const name = opts.name ?? `TextBox ${id}`;

  const sp = buildSpBase(doc, id, name, true);
  const spPr = childByLocalName(sp, 'spPr');
  if (!spPr) throw ToolError.internal('sp scaffold missing spPr');

  populateSpPr(spPr, { x: opts.x, y: opts.y, w: opts.w, h: opts.h, rotation: opts.rotation }, 'rect', undefined);

  // Text boxes use noFill so content shows through transparently.
  spPr.appendChild(doc.createElementNS(A_NS, 'a:noFill'));
  // Explicit no-line to match PowerPoint's default text-box styling.
  const ln = doc.createElementNS(A_NS, 'a:ln');
  ln.setAttribute('w', '9525');
  ln.appendChild(doc.createElementNS(A_NS, 'a:noFill'));
  spPr.appendChild(ln);

  const txBody = buildTxBody(doc, opts.text, {
    font_size: opts.font_size,
    bold: opts.bold,
    italic: opts.italic,
    color: opts.color,
    font: opts.font,
    align: opts.align,
  });
  sp.appendChild(txBody);

  spTree.appendChild(sp);
  return { xml: serializeXml(doc), new_shape_id: String(id) };
};

export interface AddPresetShapeOptions {
  /** Preset geometry name ("rect", "roundRect", "ellipse", "triangle", "rightArrow", "star5", ...). */
  preset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  /** Solid fill color as hex. Omit for no fill. */
  fill?: string;
  /** Optional text to render inside the shape. */
  text?: string;
  text_formatting?: TextFormatting;
  name?: string;
}

/**
 * Add a new preset shape (rectangle, ellipse, arrow, star, ...) to a slide.
 * See the OOXML DrawingML spec for the full list of valid preset names.
 */
export const addPresetShape = (
  slideXml: string,
  opts: AddPresetShapeOptions,
): { xml: string; new_shape_id: string } => {
  const doc = parseXml(slideXml);
  const spTree = findSpTree(doc);
  if (!spTree) throw ToolError.internal('Slide has no spTree');

  const id = getMaxCNvPrId(doc) + 1;
  const name = opts.name ?? `Shape ${id}`;

  const sp = buildSpBase(doc, id, name, false);
  const spPr = childByLocalName(sp, 'spPr');
  if (!spPr) throw ToolError.internal('sp scaffold missing spPr');

  populateSpPr(spPr, { x: opts.x, y: opts.y, w: opts.w, h: opts.h, rotation: opts.rotation }, opts.preset, opts.fill);

  // Shapes always need a txBody (even if empty) per OOXML schema.
  const text = opts.text ?? '';
  const fmt: TextFormatting = {
    align: 'center',
    ...opts.text_formatting,
  };
  sp.appendChild(buildTxBody(doc, text, fmt));

  spTree.appendChild(sp);
  return { xml: serializeXml(doc), new_shape_id: String(id) };
};

// --- Multi-file operations (Phase 3b) ---

const IMAGE_CONTENT_TYPES: Record<string, { ext: string; mime: string }> = {
  png: { ext: 'png', mime: 'image/png' },
  jpg: { ext: 'jpg', mime: 'image/jpeg' },
  jpeg: { ext: 'jpeg', mime: 'image/jpeg' },
  gif: { ext: 'gif', mime: 'image/gif' },
  bmp: { ext: 'bmp', mime: 'image/bmp' },
  tiff: { ext: 'tiff', mime: 'image/tiff' },
  svg: { ext: 'svg', mime: 'image/svg+xml' },
};

/** Decode a base64 string (with or without data: prefix) into bytes. */
const decodeBase64 = (input: string): Uint8Array => {
  const stripped = input.replace(/^data:[^;]+;base64,/, '');
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Scan a rels document for the highest rId<N> and return the next id as `rIdN+1`. */
const nextRelId = (relsDoc: Document): string => {
  let max = 0;
  const walker = relsDoc.createTreeWalker(relsDoc, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === 'Relationship') {
      const id = node.getAttribute('Id') ?? '';
      const m = id.match(/^rId(\d+)$/);
      if (m) {
        const n = Number.parseInt(m[1] ?? '0', 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    node = walker.nextNode();
  }
  return `rId${max + 1}`;
};

/** Find the next available `ppt/media/imageN.<ext>` filename. */
const nextMediaName = (entries: Map<string, Uint8Array>, ext: string): string => {
  let max = 0;
  for (const key of entries.keys()) {
    const m = key.match(/^ppt\/media\/image(\d+)\./);
    if (m) {
      const n = Number.parseInt(m[1] ?? '0', 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `ppt/media/image${max + 1}.${ext}`;
};

/** Ensure `[Content_Types].xml` has a Default entry for the given extension. */
const ensureContentTypeDefault = (entries: Map<string, Uint8Array>, ext: string, mime: string): void => {
  const data = entries.get('[Content_Types].xml');
  if (!data) throw ToolError.internal('[Content_Types].xml missing from archive');
  const doc = parseXml(TEXT_DECODER.decode(data));
  const types = doc.documentElement;
  if (!types || types.localName !== 'Types') throw ToolError.internal('Malformed [Content_Types].xml');

  for (const child of childElements(types)) {
    if (child.localName === 'Default' && child.getAttribute('Extension')?.toLowerCase() === ext.toLowerCase()) {
      return;
    }
  }

  const def = doc.createElementNS(CT_NS, 'Default');
  def.setAttribute('Extension', ext);
  def.setAttribute('ContentType', mime);
  // Defaults conventionally come before Overrides.
  const firstOverride = childElements(types).find(c => c.localName === 'Override');
  if (firstOverride) types.insertBefore(def, firstOverride);
  else types.appendChild(def);

  entries.set('[Content_Types].xml', TEXT_ENCODER.encode(serializeXml(doc)));
};

/** Remove the `[Content_Types].xml` Override entries naming any of the given parts. */
const removeContentTypeOverrides = (entries: Map<string, Uint8Array>, partPaths: string[]): void => {
  const data = entries.get('[Content_Types].xml');
  if (!data) throw ToolError.internal('[Content_Types].xml missing from archive');
  const doc = parseXml(TEXT_DECODER.decode(data));
  const types = doc.documentElement;
  if (!types || types.localName !== 'Types') throw ToolError.internal('Malformed [Content_Types].xml');

  const partNames = new Set(partPaths.map(p => `/${p}`));
  for (const child of childElements(types)) {
    if (child.localName === 'Override' && partNames.has(child.getAttribute('PartName') ?? '')) {
      types.removeChild(child);
    }
  }

  entries.set('[Content_Types].xml', TEXT_ENCODER.encode(serializeXml(doc)));
};

/** Add an Override element to `[Content_Types].xml` for a new part. */
const addContentTypeOverride = (entries: Map<string, Uint8Array>, partName: string, contentType: string): void => {
  const data = entries.get('[Content_Types].xml');
  if (!data) throw ToolError.internal('[Content_Types].xml missing from archive');
  const doc = parseXml(TEXT_DECODER.decode(data));
  const types = doc.documentElement;
  if (!types || types.localName !== 'Types') throw ToolError.internal('Malformed [Content_Types].xml');

  for (const child of childElements(types)) {
    if (child.localName === 'Override' && child.getAttribute('PartName') === partName) return;
  }

  const override = doc.createElementNS(CT_NS, 'Override');
  override.setAttribute('PartName', partName);
  override.setAttribute('ContentType', contentType);
  types.appendChild(override);

  entries.set('[Content_Types].xml', TEXT_ENCODER.encode(serializeXml(doc)));
};

export interface AddImageOptions {
  /** Base64-encoded image bytes. May include a `data:image/...;base64,` prefix. */
  base64: string;
  /** Image format: png, jpeg, jpg, gif, bmp, tiff, svg. */
  format: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  name?: string;
}

/**
 * Insert an image onto a slide. Writes the image bytes into `ppt/media/`,
 * adds a relationship from the slide to the media part, ensures the
 * content-type default exists, and appends a `<p:pic>` to the slide's spTree.
 */
export const addImageToSlide = (
  entries: Map<string, Uint8Array>,
  slideNumber: number,
  opts: AddImageOptions,
): { new_shape_id: string } => {
  const formatKey = opts.format.toLowerCase().replace(/^\./, '');
  const ct = IMAGE_CONTENT_TYPES[formatKey];
  if (!ct) {
    throw ToolError.validation(
      `Unsupported image format "${opts.format}" — expected one of: ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`,
    );
  }

  const slideFiles = getSlideList(entries);
  if (slideNumber < 1 || slideNumber > slideFiles.length) {
    throw ToolError.notFound(`Slide ${slideNumber} not found — presentation has ${slideFiles.length} slides`);
  }
  const slideFile = slideFiles[slideNumber - 1];
  if (!slideFile) throw ToolError.notFound(`Slide ${slideNumber} not found`);
  const slideBaseName = slideFile.split('/').pop()?.replace('.xml', '') ?? '';
  const relsPath = `ppt/slides/_rels/${slideBaseName}.xml.rels`;

  // 1. Decode image bytes and pick a media filename.
  const imageBytes = decodeBase64(opts.base64);
  const mediaPath = nextMediaName(entries, ct.ext);
  const mediaBaseName = mediaPath.split('/').pop() ?? '';
  entries.set(mediaPath, imageBytes);

  // 2. Ensure [Content_Types].xml has a Default for this extension.
  ensureContentTypeDefault(entries, ct.ext, ct.mime);

  // 3. Add a relationship from the slide to the new media part.
  const relsData = entries.get(relsPath);
  let relsDoc: Document;
  if (relsData) {
    relsDoc = parseXml(TEXT_DECODER.decode(relsData));
  } else {
    // Rare: a slide with no existing rels file. Create one.
    relsDoc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL_NS}"/>`);
  }
  const relsRoot = relsDoc.documentElement;
  if (!relsRoot) throw ToolError.internal(`Malformed slide rels: ${relsPath}`);
  const rId = nextRelId(relsDoc);
  const rel = relsDoc.createElementNS(PKG_REL_NS, 'Relationship');
  rel.setAttribute('Id', rId);
  rel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image');
  rel.setAttribute('Target', `../media/${mediaBaseName}`);
  relsRoot.appendChild(rel);
  entries.set(relsPath, TEXT_ENCODER.encode(serializeXml(relsDoc)));

  // 4. Append a <p:pic> element to the slide's spTree.
  const slideData = entries.get(slideFile);
  if (!slideData) throw ToolError.internal(`Slide file missing: ${slideFile}`);
  const slideDoc = parseXml(TEXT_DECODER.decode(slideData));
  const spTree = findSpTree(slideDoc);
  if (!spTree) throw ToolError.internal('Slide has no spTree');

  const id = getMaxCNvPrId(slideDoc) + 1;
  const name = opts.name ?? `Picture ${id}`;

  const pic = slideDoc.createElementNS(P_NS, 'p:pic');

  const nvPicPr = slideDoc.createElementNS(P_NS, 'p:nvPicPr');
  const cNvPr = slideDoc.createElementNS(P_NS, 'p:cNvPr');
  cNvPr.setAttribute('id', String(id));
  cNvPr.setAttribute('name', name);
  nvPicPr.appendChild(cNvPr);
  const cNvPicPr = slideDoc.createElementNS(P_NS, 'p:cNvPicPr');
  const picLocks = slideDoc.createElementNS(A_NS, 'a:picLocks');
  picLocks.setAttribute('noChangeAspect', '1');
  cNvPicPr.appendChild(picLocks);
  nvPicPr.appendChild(cNvPicPr);
  nvPicPr.appendChild(slideDoc.createElementNS(P_NS, 'p:nvPr'));
  pic.appendChild(nvPicPr);

  const blipFill = slideDoc.createElementNS(P_NS, 'p:blipFill');
  const blip = slideDoc.createElementNS(A_NS, 'a:blip');
  // r:embed must be in the relationships namespace. The slide root already
  // declares xmlns:r so the serializer will reuse the "r" prefix.
  blip.setAttributeNS(R_NS, 'r:embed', rId);
  blipFill.appendChild(blip);
  const stretch = slideDoc.createElementNS(A_NS, 'a:stretch');
  stretch.appendChild(slideDoc.createElementNS(A_NS, 'a:fillRect'));
  blipFill.appendChild(stretch);
  pic.appendChild(blipFill);

  const spPr = slideDoc.createElementNS(P_NS, 'p:spPr');
  populateSpPr(spPr, { x: opts.x, y: opts.y, w: opts.w, h: opts.h, rotation: opts.rotation }, 'rect', undefined);
  pic.appendChild(spPr);

  spTree.appendChild(pic);
  entries.set(slideFile, TEXT_ENCODER.encode(serializeXml(slideDoc)));

  return { new_shape_id: String(id) };
};

// --- Tables ---

const TABLE_GRAPHIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table';

/**
 * Built-in table styles, referenced by the GUID PowerPoint compiles in.
 *
 * These need no `ppt/tableStyles.xml` — that part holds only *custom* styles, so
 * emitting a built-in GUID keeps a table entirely within the slide part. The
 * default matches what PowerPoint's own Insert Table produces.
 */
/** Medium Style 2 – Accent 1, what PowerPoint's own Insert Table produces. */
const DEFAULT_TABLE_STYLE_ID = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';

const TABLE_STYLE_IDS: Record<string, string> = {
  default: DEFAULT_TABLE_STYLE_ID,
  grid: '{5940675A-B579-460E-94D1-54222C63F5DA}', // No Style, Table Grid
};

/**
 * Split a total length in inches into `parts` EMU spans that sum *exactly* to
 * the total, giving the remainder to the last span.
 *
 * PowerPoint rewrites a table's geometry on save unless `sum(gridCol) == ext.cx`
 * and `sum(tr) == ext.cy` to the EMU — and then the coordinates a caller reads
 * back would not match what it asked for. Distributing exactly avoids that.
 */
const distributeEmu = (totalInches: number, parts: number): number[] => {
  const total = inchesToEmu(totalInches);
  const base = Math.floor(total / parts);
  const spans = new Array<number>(parts).fill(base);
  spans[parts - 1] = total - base * (parts - 1);
  return spans;
};

/** Build a table cell's `<a:txBody>` — DrawingML, not the PresentationML body used elsewhere. */
const buildCellTxBody = (doc: Document, text: string): Element => {
  const txBody = doc.createElementNS(A_NS, 'a:txBody');
  txBody.appendChild(doc.createElementNS(A_NS, 'a:bodyPr'));
  txBody.appendChild(doc.createElementNS(A_NS, 'a:lstStyle'));

  const lines = text.length > 0 ? text.split('\n') : [''];
  for (const line of lines) {
    const p = doc.createElementNS(A_NS, 'a:p');
    if (line.length > 0) {
      const r = doc.createElementNS(A_NS, 'a:r');
      const rPr = doc.createElementNS(A_NS, 'a:rPr');
      rPr.setAttribute('lang', 'en-US');
      rPr.setAttribute('dirty', '0');
      r.appendChild(rPr);
      const t = doc.createElementNS(A_NS, 'a:t');
      t.textContent = line;
      r.appendChild(t);
      p.appendChild(r);
    } else {
      // An empty cell still needs one paragraph; endParaRPr carries its run
      // properties so the cell keeps a stable baseline height.
      const endParaRPr = doc.createElementNS(A_NS, 'a:endParaRPr');
      endParaRPr.setAttribute('lang', 'en-US');
      p.appendChild(endParaRPr);
    }
    txBody.appendChild(p);
  }
  return txBody;
};

export interface AddTableOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row-major cell text. Ragged rows are padded to the widest row with empty cells. */
  data: string[][];
  /** Style the first row as a header (bold, filled). Defaults to true. */
  headerRow?: boolean;
  /** Alternate row shading. Defaults to true. */
  bandRow?: boolean;
  /** "default", "grid", "none", or a literal built-in style GUID like "{...}". */
  style?: string;
  name?: string;
}

/**
 * Add a table to a slide.
 *
 * A table is inline DrawingML inside a `<p:graphicFrame>` — no new package part,
 * no relationship, no content-type change. Every row is emitted with exactly one
 * cell per column (ragged input is padded), because a row whose cell count
 * disagrees with the grid makes PowerPoint offer to repair the file.
 */
export const addTableToSlide = (slideXml: string, opts: AddTableOptions): { xml: string; new_shape_id: string } => {
  const doc = parseXml(slideXml);
  const spTree = findSpTree(doc);
  if (!spTree) throw ToolError.internal('Slide has no spTree');

  const rows = opts.data.length;
  if (rows === 0) throw ToolError.validation('A table needs at least one row');
  const cols = Math.max(...opts.data.map(r => r.length));
  if (cols === 0) throw ToolError.validation('A table needs at least one column');

  const id = getMaxCNvPrId(doc) + 1;
  const colWidths = distributeEmu(opts.w, cols);
  const rowHeights = distributeEmu(opts.h, rows);

  const graphicFrame = doc.createElementNS(P_NS, 'p:graphicFrame');

  const nvGraphicFramePr = doc.createElementNS(P_NS, 'p:nvGraphicFramePr');
  const cNvPr = doc.createElementNS(P_NS, 'p:cNvPr');
  cNvPr.setAttribute('id', String(id));
  cNvPr.setAttribute('name', opts.name ?? `Table ${id}`);
  nvGraphicFramePr.appendChild(cNvPr);
  const cNvGraphicFramePr = doc.createElementNS(P_NS, 'p:cNvGraphicFramePr');
  const locks = doc.createElementNS(A_NS, 'a:graphicFrameLocks');
  locks.setAttribute('noGrp', '1');
  cNvGraphicFramePr.appendChild(locks);
  nvGraphicFramePr.appendChild(cNvGraphicFramePr);
  nvGraphicFramePr.appendChild(doc.createElementNS(P_NS, 'p:nvPr'));
  graphicFrame.appendChild(nvGraphicFramePr);

  // The frame's xfrm is a PresentationML element with DrawingML off/ext children.
  const xfrm = doc.createElementNS(P_NS, 'p:xfrm');
  const off = doc.createElementNS(A_NS, 'a:off');
  off.setAttribute('x', String(inchesToEmu(opts.x)));
  off.setAttribute('y', String(inchesToEmu(opts.y)));
  xfrm.appendChild(off);
  const ext = doc.createElementNS(A_NS, 'a:ext');
  ext.setAttribute('cx', String(colWidths.reduce((a, b) => a + b, 0)));
  ext.setAttribute('cy', String(rowHeights.reduce((a, b) => a + b, 0)));
  xfrm.appendChild(ext);
  graphicFrame.appendChild(xfrm);

  const graphic = doc.createElementNS(A_NS, 'a:graphic');
  const graphicData = doc.createElementNS(A_NS, 'a:graphicData');
  graphicData.setAttribute('uri', TABLE_GRAPHIC_URI);
  const tbl = doc.createElementNS(A_NS, 'a:tbl');

  const style = opts.style ?? 'default';
  if (style !== 'none') {
    const tblPr = doc.createElementNS(A_NS, 'a:tblPr');
    tblPr.setAttribute('firstRow', opts.headerRow === false ? '0' : '1');
    tblPr.setAttribute('bandRow', opts.bandRow === false ? '0' : '1');
    const guid = TABLE_STYLE_IDS[style] ?? (/^\{[0-9A-Fa-f-]+\}$/.test(style) ? style : DEFAULT_TABLE_STYLE_ID);
    const tableStyleId = doc.createElementNS(A_NS, 'a:tableStyleId');
    tableStyleId.textContent = guid;
    tblPr.appendChild(tableStyleId);
    tbl.appendChild(tblPr);
  }

  const tblGrid = doc.createElementNS(A_NS, 'a:tblGrid');
  for (const w of colWidths) {
    const gridCol = doc.createElementNS(A_NS, 'a:gridCol');
    gridCol.setAttribute('w', String(w));
    tblGrid.appendChild(gridCol);
  }
  tbl.appendChild(tblGrid);

  for (let ri = 0; ri < rows; ri++) {
    const tr = doc.createElementNS(A_NS, 'a:tr');
    tr.setAttribute('h', String(rowHeights[ri]));
    for (let ci = 0; ci < cols; ci++) {
      const tc = doc.createElementNS(A_NS, 'a:tc');
      tc.appendChild(buildCellTxBody(doc, opts.data[ri]?.[ci] ?? ''));
      tc.appendChild(doc.createElementNS(A_NS, 'a:tcPr'));
      tr.appendChild(tc);
    }
    tbl.appendChild(tr);
  }

  graphicData.appendChild(tbl);
  graphic.appendChild(graphicData);
  graphicFrame.appendChild(graphic);
  spTree.appendChild(graphicFrame);

  return { xml: serializeXml(doc), new_shape_id: String(id) };
};

// --- duplicate_slide ---

/** Return the highest slide index currently in the archive (e.g. slide5.xml → 5). */
const getMaxSlideIndex = (entries: Map<string, Uint8Array>): number => {
  let max = 0;
  for (const key of entries.keys()) {
    const m = key.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) {
      const n = Number.parseInt(m[1] ?? '0', 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
};

const NOTES_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const NOTES_MASTER_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';
const NOTES_SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

/** Highest `ppt/notesSlides/notesSlideN.xml` index in the archive (0 if none). */
const getMaxNotesSlideIndex = (entries: Map<string, Uint8Array>): number => {
  let max = 0;
  for (const key of entries.keys()) {
    const m = key.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
    if (m) {
      const n = Number.parseInt(m[1] ?? '0', 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
};

/** Filename of the deck's notes master (e.g. "notesMaster1.xml"), or null if none exists. */
const findNotesMasterName = (entries: Map<string, Uint8Array>): string | null => {
  for (const key of entries.keys()) {
    const m = key.match(/^ppt\/notesMasters\/(notesMaster\d+\.xml)$/);
    if (m?.[1]) return m[1];
  }
  return null;
};

/** Retarget (or, if no replacement, remove) a cloned slide's notesSlide relationship. */
const retargetNotesRelationship = (relsDoc: Document, newNotesBaseName: string | null): void => {
  const relsRoot = relsDoc.documentElement;
  if (!relsRoot) return;
  const toRemove: Element[] = [];
  for (const child of childElements(relsRoot)) {
    if (child.localName !== 'Relationship' || !(child.getAttribute('Type') ?? '').includes('/notesSlide')) continue;
    if (newNotesBaseName) child.setAttribute('Target', `../notesSlides/${newNotesBaseName}.xml`);
    else toRemove.push(child);
  }
  for (const el of toRemove) relsRoot.removeChild(el);
};

/**
 * Strip comment relationships from a cloned slide's rels.
 *
 * Comments are review annotations on a specific slide instance, and the modern
 * comment part's filename encodes the identity of the slide that owns it.
 * Carrying the relationship across would leave two slides pointing at one part,
 * so the clone starts with no comments — which is also what duplicating a slide
 * in PowerPoint itself does.
 */
const dropCommentRelationships = (relsDoc: Document): void => {
  const relsRoot = relsDoc.documentElement;
  if (!relsRoot) return;
  const toRemove = childElements(relsRoot).filter(
    child =>
      child.localName === 'Relationship' && (child.getAttribute('Type') ?? '').includes('/relationships/comments'),
  );
  for (const el of toRemove) relsRoot.removeChild(el);
};

/** Minimal notesSlide XML with an empty body placeholder for `replaceNotesText` to fill. */
const buildEmptyNotesSlideXml = (): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:notes xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
  `<p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/>` +
  `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t></a:t></a:r></a:p></p:txBody>` +
  `</p:sp></p:spTree></p:cSld></p:notes>`;

/** notesSlide rels referencing the notes master and back to the owning slide. */
const buildNotesSlideRels = (notesMasterName: string, slideBaseName: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${PKG_REL_NS}">` +
  `<Relationship Id="rId1" Type="${NOTES_MASTER_REL_TYPE}" Target="../notesMasters/${notesMasterName}"/>` +
  `<Relationship Id="rId2" Type="${SLIDE_REL_TYPE}" Target="../slides/${slideBaseName}.xml"/>` +
  `</Relationships>`;

/** Add a slide → notesSlide relationship to a slide's rels file, creating the rels file if absent. */
const addSlideNotesRelationship = (
  entries: Map<string, Uint8Array>,
  slideBaseName: string,
  notesBaseName: string,
): void => {
  const relsPath = `ppt/slides/_rels/${slideBaseName}.xml.rels`;
  const relsData = entries.get(relsPath);
  const relsDoc = relsData
    ? parseXml(TEXT_DECODER.decode(relsData))
    : parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL_NS}"/>`);
  const root = relsDoc.documentElement;
  if (!root) throw ToolError.internal(`Malformed slide rels: ${relsPath}`);
  const rel = relsDoc.createElementNS(PKG_REL_NS, 'Relationship');
  rel.setAttribute('Id', nextRelId(relsDoc));
  rel.setAttribute('Type', NOTES_SLIDE_REL_TYPE);
  rel.setAttribute('Target', `../notesSlides/${notesBaseName}.xml`);
  root.appendChild(rel);
  entries.set(relsPath, TEXT_ENCODER.encode(serializeXml(relsDoc)));
};

/**
 * Return the notes-slide path for a slide, creating an empty notes part if the
 * slide has none. Requires the deck to have a notes master (every deck authored
 * in PowerPoint does); throws an actionable error if one is missing.
 */
export const ensureNotesSlide = (entries: Map<string, Uint8Array>, slideFile: string): string => {
  const existing = getNotesForSlide(entries, slideFile);
  if (existing) return existing;

  const notesMasterName = findNotesMasterName(entries);
  if (!notesMasterName) {
    throw ToolError.validation(
      'This presentation has no notes master, so speaker notes cannot be created. Open the deck in PowerPoint, add a note to any slide once to initialize the notes master, then retry.',
    );
  }

  const slideBaseName = slideFile.split('/').pop()?.replace('.xml', '') ?? '';
  const newBaseName = `notesSlide${getMaxNotesSlideIndex(entries) + 1}`;
  const newNotesPath = `ppt/notesSlides/${newBaseName}.xml`;
  const newNotesRelsPath = `ppt/notesSlides/_rels/${newBaseName}.xml.rels`;

  entries.set(newNotesPath, TEXT_ENCODER.encode(buildEmptyNotesSlideXml()));
  entries.set(newNotesRelsPath, TEXT_ENCODER.encode(buildNotesSlideRels(notesMasterName, slideBaseName)));
  addContentTypeOverride(entries, `/${newNotesPath}`, NOTES_SLIDE_CONTENT_TYPE);
  addSlideNotesRelationship(entries, slideBaseName, newBaseName);

  return newNotesPath;
};

/**
 * Copy a source slide's notes part for a freshly cloned slide. Writes a new
 * notesSlide (byte-copy, so text carries over), retargets its slide back-ref to
 * the clone, registers the content type, and returns the new notes base name so
 * the clone's rels can point at it. Returns null if the source has no notes.
 */
const copyNotesForClone = (
  entries: Map<string, Uint8Array>,
  sourceFile: string,
  cloneBaseName: string,
): string | null => {
  const sourceNotesPath = getNotesForSlide(entries, sourceFile);
  if (!sourceNotesPath) return null;
  const sourceNotesData = entries.get(sourceNotesPath);
  if (!sourceNotesData) return null;

  const newBaseName = `notesSlide${getMaxNotesSlideIndex(entries) + 1}`;
  const newNotesPath = `ppt/notesSlides/${newBaseName}.xml`;
  entries.set(newNotesPath, new Uint8Array(sourceNotesData));

  const sourceNotesBase = sourceNotesPath.split('/').pop()?.replace('.xml', '') ?? '';
  const sourceNotesRels = entries.get(`ppt/notesSlides/_rels/${sourceNotesBase}.xml.rels`);
  if (sourceNotesRels) {
    const ndoc = parseXml(TEXT_DECODER.decode(sourceNotesRels));
    const root = ndoc.documentElement;
    if (root) {
      for (const child of childElements(root)) {
        if (child.localName === 'Relationship' && (child.getAttribute('Type') ?? '').endsWith('/slide')) {
          child.setAttribute('Target', `../slides/${cloneBaseName}.xml`);
        }
      }
    }
    entries.set(`ppt/notesSlides/_rels/${newBaseName}.xml.rels`, TEXT_ENCODER.encode(serializeXml(ndoc)));
  }

  addContentTypeOverride(entries, `/${newNotesPath}`, NOTES_SLIDE_CONTENT_TYPE);
  return newBaseName;
};

export interface DuplicateSlideResult {
  new_slide_number: number;
  total_slides: number;
}

/**
 * Duplicate an existing slide. Copies the slide XML and rels, updates
 * `[Content_Types].xml`, `ppt/_rels/presentation.xml.rels`, and the
 * `<p:sldIdLst>` in `ppt/presentation.xml`. If the source slide has speaker
 * notes, the clone gets its own independent copy of them (not a shared
 * reference) so editing one slide's notes never affects the other.
 */
export const duplicateSlide = (
  entries: Map<string, Uint8Array>,
  sourceSlideNumber: number,
  insertAt?: number,
): DuplicateSlideResult => {
  const slideFiles = getSlideList(entries);
  if (sourceSlideNumber < 1 || sourceSlideNumber > slideFiles.length) {
    throw ToolError.notFound(`Slide ${sourceSlideNumber} not found — presentation has ${slideFiles.length} slides`);
  }
  const sourceFile = slideFiles[sourceSlideNumber - 1];
  if (!sourceFile) throw ToolError.notFound(`Slide ${sourceSlideNumber} not found`);
  const sourceBaseName = sourceFile.split('/').pop()?.replace('.xml', '') ?? '';
  const sourceRelsPath = `ppt/slides/_rels/${sourceBaseName}.xml.rels`;

  const sourceSlideData = entries.get(sourceFile);
  if (!sourceSlideData) throw ToolError.internal(`Source slide file missing: ${sourceFile}`);

  // 1. Allocate a new slideN filename.
  const newIndex = getMaxSlideIndex(entries) + 1;
  const newBaseName = `slide${newIndex}`;
  const newSlideFile = `ppt/slides/${newBaseName}.xml`;
  const newRelsPath = `ppt/slides/_rels/${newBaseName}.xml.rels`;

  // 2. Copy the slide XML bytes as-is.
  entries.set(newSlideFile, new Uint8Array(sourceSlideData));

  // 3. Copy the source's notes slide (if any) so the clone gets its own
  //    independent notes, then copy the slide rels and point the notesSlide
  //    relationship at the copy (or drop it if the source had no notes).
  const clonedNotesBase = copyNotesForClone(entries, sourceFile, newBaseName);
  const sourceRelsData = entries.get(sourceRelsPath);
  if (sourceRelsData) {
    const relsDoc = parseXml(TEXT_DECODER.decode(sourceRelsData));
    retargetNotesRelationship(relsDoc, clonedNotesBase);
    dropCommentRelationships(relsDoc);
    entries.set(newRelsPath, TEXT_ENCODER.encode(serializeXml(relsDoc)));
  }

  // 4-7. Register the part with the package: content-type override,
  //      presentation relationship, and sldIdLst entry at the target position.
  return registerSlidePart(entries, newBaseName, slideFiles.length, insertAt);
};

/** A slide document with an empty shape tree, ready for placeholders to be appended. */
const EMPTY_SLIDE_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
  `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

/** Build a slide part holding one empty placeholder per slot the layout defines. */
const buildSlideFromLayout = (specs: PlaceholderSpec[]): string => {
  const doc = parseXml(EMPTY_SLIDE_XML);
  const spTree = findSpTree(doc);
  if (!spTree) throw ToolError.internal('Slide scaffold has no spTree');
  // Shape id 1 belongs to the shape tree's own group, so slots start at 2.
  for (const [i, spec] of specs.entries()) appendPlaceholder(spTree, spec, i + 2, i + 1);
  return serializeXml(doc);
};

/**
 * Create a slide from a layout, the way PowerPoint's own New Slide does.
 *
 * The layout defaults to the one slide 1 uses, so a deck's prevailing look is
 * kept without the caller having to name a part.
 */
export const addSlide = (
  entries: Map<string, Uint8Array>,
  opts: { layoutPart?: string; insertAt?: number } = {},
): DuplicateSlideResult => {
  const slideFiles = getSlideList(entries);
  const layoutPart =
    opts.layoutPart ?? (slideFiles[0] ? getRelatedParts(entries, slideFiles[0], '/slideLayout')[0] : undefined);
  if (!layoutPart) throw ToolError.notFound('Could not resolve a slide layout to build the new slide from');

  // A caller-supplied path is written verbatim into a relationship target, so
  // it has to be a layout and nothing else: pointing the relationship at some
  // other part yields a slide PowerPoint cannot render, and a path carrying XML
  // metacharacters would corrupt the rels part outright.
  if (!/^ppt\/slideLayouts\/[\w.-]+\.xml$/.test(layoutPart)) {
    throw ToolError.validation(
      `Not a slide layout part: "${layoutPart}". Expected a path like "ppt/slideLayouts/slideLayout2.xml" — ` +
        `get one from \`get_slide_structure\`.`,
    );
  }
  const layoutData = entries.get(layoutPart);
  if (!layoutData) throw ToolError.notFound(`Slide layout not found in this presentation: ${layoutPart}`);

  const specs = readLayoutSlots(TEXT_DECODER.decode(layoutData));
  const newBaseName = `slide${getMaxSlideIndex(entries) + 1}`;
  entries.set(`ppt/slides/${newBaseName}.xml`, TEXT_ENCODER.encode(buildSlideFromLayout(specs)));

  // The slide must point at the layout it was built from; the relative target
  // steps out of `ppt/slides/` and back into the layout's own directory.
  const layoutTarget = `../${layoutPart.replace(/^ppt\//, '')}`;
  entries.set(
    `ppt/slides/_rels/${newBaseName}.xml.rels`,
    TEXT_ENCODER.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${PKG_REL_NS}">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" ` +
        `Target="${layoutTarget}"/></Relationships>`,
    ),
  );

  return registerSlidePart(entries, newBaseName, slideFiles.length, opts.insertAt);
};

/** Locate the `<p:sldIdLst>` in a parsed `ppt/presentation.xml`. */
const findSldIdLst = (presDoc: Document): Element => {
  const walker = presDoc.createTreeWalker(presDoc, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === 'sldIdLst') return node;
    node = walker.nextNode();
  }
  throw ToolError.internal('presentation.xml has no sldIdLst');
};

/**
 * Whether a slide is hidden from the slide show.
 *
 * Hiding is `<p:sld show="0">` on the slide root. The attribute defaults to
 * true, so a slide that states nothing is visible — which is how nearly every
 * slide is stored, and why its absence must not be read as hidden.
 */
export const isSlideHidden = (slideXml: string): boolean => {
  const show = parseXml(slideXml).documentElement?.getAttribute('show');
  return show === '0' || show === 'false';
};

/**
 * Hide a slide from the slide show, or restore it.
 *
 * A hidden slide stays in the deck, keeps its number, and is still editable —
 * it is simply skipped when presenting. Restoring visibility removes the
 * attribute rather than writing `show="1"`: true is the schema default and
 * PowerPoint omits it, so writing it back would leave a fingerprint on every
 * slide this ever touched.
 */
export const setSlideHidden = (slideXml: string, hidden: boolean): string => {
  const doc = parseXml(slideXml);
  const root = doc.documentElement;
  if (!root) throw ToolError.internal('Empty slide XML');
  if (hidden) root.setAttribute('show', '0');
  else root.removeAttribute('show');
  return serializeXml(doc);
};

export interface MoveSlideResult {
  new_position: number;
  total_slides: number;
}

/**
 * Move a slide to another position in the deck.
 *
 * Slide order lives entirely in `<p:sldIdLst>` — the `slideN.xml` filenames are
 * allocation order and mean nothing to the reader — so reordering is a move
 * within that one list and touches no other part.
 *
 * Positions are 1-indexed and describe where the slide ends up *after* the
 * move, which is what a person means by "make this slide 2".
 */
export const moveSlide = (entries: Map<string, Uint8Array>, from: number, to: number): MoveSlideResult => {
  const presData = entries.get('ppt/presentation.xml');
  if (!presData) throw ToolError.internal('ppt/presentation.xml missing');
  const presDoc = parseXml(TEXT_DECODER.decode(presData));
  const sldIdLst = findSldIdLst(presDoc);
  const sldIds = childElements(sldIdLst).filter(c => c.localName === 'sldId');

  const moving = from >= 1 ? sldIds[from - 1] : undefined;
  if (!moving) {
    throw ToolError.notFound(`Slide ${from} not found — presentation has ${sldIds.length} slides`);
  }
  const target = Math.max(1, Math.min(to, sldIds.length));

  // Remove first, then re-insert against the shortened list, so a target
  // position is read the way a person means it: where the slide ends up, not
  // where it would land if everything else stayed put.
  sldIdLst.removeChild(moving);
  const remaining = childElements(sldIdLst).filter(c => c.localName === 'sldId');
  const anchor = remaining[target - 1];
  if (anchor) sldIdLst.insertBefore(moving, anchor);
  else sldIdLst.appendChild(moving);

  entries.set('ppt/presentation.xml', TEXT_ENCODER.encode(serializeXml(presDoc)));
  return { new_position: target, total_slides: sldIds.length };
};

/**
 * Remove a slide from the package along with every reference to it.
 *
 * The inverse of `registerSlidePart`. A slide is named in four places, and
 * leaving any one behind produces a dangling reference that PowerPoint reports
 * as a damaged file, so each is resolved structurally rather than by matching
 * text: the presentation relationship is found by resolving its `Target` back to
 * this slide's path — which is correct whether the target is written relative or
 * package-absolute — and the `<p:sldId>` by the relationship id that lookup
 * yields.
 *
 * @param ownedParts parts referenced by this slide alone, deleted along with it.
 */
export const removeSlideFromPackage = (
  entries: Map<string, Uint8Array>,
  slideFile: string,
  ownedParts: string[],
): void => {
  // 1. Delete the slide, its relationships, and the parts it alone owned.
  const deletedParts = [slideFile, ...ownedParts];
  for (const part of deletedParts) {
    entries.delete(part);
    entries.delete(relsPathFor(part));
  }

  // 2. Drop the presentation → slide relationship, keeping its id to find the
  //    slide's entry in the slide order.
  const presRelsData = entries.get('ppt/_rels/presentation.xml.rels');
  if (!presRelsData) throw ToolError.internal('ppt/_rels/presentation.xml.rels missing');
  const presRelsDoc = parseXml(TEXT_DECODER.decode(presRelsData));
  const presRelsRoot = presRelsDoc.documentElement;
  if (!presRelsRoot) throw ToolError.internal('Malformed presentation.xml.rels');

  let slideRelId: string | undefined;
  for (const child of childElements(presRelsRoot)) {
    if (child.localName !== 'Relationship') continue;
    const target = child.getAttribute('Target') ?? '';
    if (!target || resolveRelTarget('ppt/presentation.xml', target) !== slideFile) continue;
    slideRelId = child.getAttribute('Id') ?? undefined;
    presRelsRoot.removeChild(child);
  }
  entries.set('ppt/_rels/presentation.xml.rels', TEXT_ENCODER.encode(serializeXml(presRelsDoc)));

  // 3. Drop the slide's place in the slide order.
  const presData = entries.get('ppt/presentation.xml');
  if (!presData) throw ToolError.internal('ppt/presentation.xml missing');
  const presDoc = parseXml(TEXT_DECODER.decode(presData));
  const sldIdLst = findSldIdLst(presDoc);
  for (const sldId of childElements(sldIdLst)) {
    if (sldId.localName !== 'sldId') continue;
    const rId = sldId.getAttributeNS(R_NS, 'id') || sldId.getAttribute('r:id') || '';
    if (rId && rId === slideRelId) sldIdLst.removeChild(sldId);
  }
  entries.set('ppt/presentation.xml', TEXT_ENCODER.encode(serializeXml(presDoc)));

  // 4. Drop the content-type declarations for every part removed.
  removeContentTypeOverrides(entries, deletedParts);
};

/**
 * Register an already-written `ppt/slides/<baseName>.xml` part with the package.
 *
 * Shared by every slide-creating operation: writing the part is what differs
 * between duplicating a slide and building one from a layout, while declaring
 * it to the package is identical and easy to get subtly wrong.
 *
 * @param existingSlideCount slide count *before* this one was added.
 */
const registerSlidePart = (
  entries: Map<string, Uint8Array>,
  newBaseName: string,
  existingSlideCount: number,
  insertAt?: number,
): DuplicateSlideResult => {
  const newSlideFile = `ppt/slides/${newBaseName}.xml`;

  // 4. Add an Override in [Content_Types].xml.
  addContentTypeOverride(
    entries,
    `/${newSlideFile}`,
    'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  );

  // 5. Add a relationship in ppt/_rels/presentation.xml.rels.
  const presRelsData = entries.get('ppt/_rels/presentation.xml.rels');
  if (!presRelsData) throw ToolError.internal('ppt/_rels/presentation.xml.rels missing');
  const presRelsDoc = parseXml(TEXT_DECODER.decode(presRelsData));
  const presRelsRoot = presRelsDoc.documentElement;
  if (!presRelsRoot) throw ToolError.internal('Malformed presentation.xml.rels');
  const newRId = nextRelId(presRelsDoc);
  const newRel = presRelsDoc.createElementNS(PKG_REL_NS, 'Relationship');
  newRel.setAttribute('Id', newRId);
  newRel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide');
  newRel.setAttribute('Target', `slides/${newBaseName}.xml`);
  presRelsRoot.appendChild(newRel);
  entries.set('ppt/_rels/presentation.xml.rels', TEXT_ENCODER.encode(serializeXml(presRelsDoc)));

  // 6. Insert <p:sldId> into the sldIdLst in presentation.xml at the target position.
  const presData = entries.get('ppt/presentation.xml');
  if (!presData) throw ToolError.internal('ppt/presentation.xml missing');
  const presDoc = parseXml(TEXT_DECODER.decode(presData));
  const sldIdLst = findSldIdLst(presDoc);

  // sldId id values start at 256 and must be unique.
  const existingSldIds = childElements(sldIdLst).filter(c => c.localName === 'sldId');
  let maxSldIdValue = 255;
  for (const s of existingSldIds) {
    const v = Number.parseInt(s.getAttribute('id') ?? '0', 10);
    if (Number.isFinite(v) && v > maxSldIdValue) maxSldIdValue = v;
  }
  const newSldId = presDoc.createElementNS(P_NS, 'p:sldId');
  newSldId.setAttribute('id', String(maxSldIdValue + 1));
  newSldId.setAttributeNS(R_NS, 'r:id', newRId);

  const targetPosition =
    insertAt !== undefined ? Math.max(1, Math.min(insertAt, existingSldIds.length + 1)) : existingSldIds.length + 1;
  if (targetPosition > existingSldIds.length) {
    sldIdLst.appendChild(newSldId);
  } else {
    const anchor = existingSldIds[targetPosition - 1];
    if (!anchor) throw ToolError.internal('Failed to resolve sldIdLst insertion anchor');
    sldIdLst.insertBefore(newSldId, anchor);
  }

  entries.set('ppt/presentation.xml', TEXT_ENCODER.encode(serializeXml(presDoc)));

  return {
    new_slide_number: targetPosition,
    total_slides: existingSlideCount + 1,
  };
};
