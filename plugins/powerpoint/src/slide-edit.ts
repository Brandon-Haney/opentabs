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
import { getNotesForSlide, getSlideList, TEXT_DECODER, TEXT_ENCODER } from './pptx-utils.js';

// --- Units ---

const EMU_PER_INCH = 914400;
/** Rotation in OOXML is stored as 60,000ths of a degree. */
const ROT_UNITS_PER_DEG = 60000;

const inchesToEmu = (inches: number): number => Math.round(inches * EMU_PER_INCH);
const degreesToRotUnits = (deg: number): number => Math.round(deg * ROT_UNITS_PER_DEG);

// --- Namespaces ---

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

// --- XML IO ---

const xmlParser = typeof DOMParser !== 'undefined' ? new DOMParser() : undefined;
const xmlSerializer = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : undefined;

const parseXml = (xml: string): Document => {
  if (!xmlParser) throw ToolError.internal('DOMParser not available');
  return xmlParser.parseFromString(xml, 'application/xml');
};

const serializeXml = (doc: Document): string => {
  if (!xmlSerializer) throw ToolError.internal('XMLSerializer not available');
  return xmlSerializer.serializeToString(doc);
};

// --- DOM helpers ---

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

const childElements = (el: Element): Element[] => {
  const out: Element[] = [];
  for (const n of el.childNodes) if (isElement(n)) out.push(n);
  return out;
};

const childByLocalName = (el: Element, localName: string): Element | undefined =>
  childElements(el).find(c => c.localName === localName);

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

/** Replace a shape's fill with a solid color. Accepts hex with or without `#`. */
export const editShapeFill = (slideXml: string, shapeId: string, hexColor: string): string => {
  const doc = parseXml(slideXml);
  const shape = findShapeById(doc, shapeId);
  if (!shape) throw ToolError.notFound(`Shape ${shapeId} not found on slide`);
  if (shape.localName === 'pic') {
    throw ToolError.validation('Cannot set fill color on a picture shape');
  }

  const spPr = childByLocalName(shape, 'spPr') ?? childByLocalName(shape, 'grpSpPr');
  if (!spPr) throw ToolError.internal('Shape has no spPr');

  const normalized = hexColor.replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    throw ToolError.validation(`Invalid hex color: ${hexColor} — expected 6 hex digits`);
  }

  // Remove any existing fill elements to keep the shape in a consistent state.
  for (const tag of ['solidFill', 'gradFill', 'blipFill', 'pattFill', 'noFill']) {
    const existing = childByLocalName(spPr, tag);
    if (existing) spPr.removeChild(existing);
  }

  const solidFill = doc.createElementNS(A_NS, 'a:solidFill');
  const srgb = doc.createElementNS(A_NS, 'a:srgbClr');
  srgb.setAttribute('val', normalized);
  solidFill.appendChild(srgb);

  // Schema order: xfrm, custGeom/prstGeom, fill, ln, ...
  // Insert fill after geometry if present, else after xfrm, else at end.
  const geom = childByLocalName(spPr, 'prstGeom') ?? childByLocalName(spPr, 'custGeom');
  const xfrm = childByLocalName(spPr, 'xfrm');
  const anchor = geom ?? xfrm;
  if (anchor?.nextSibling) spPr.insertBefore(solidFill, anchor.nextSibling);
  else spPr.appendChild(solidFill);

  return serializeXml(doc);
};

/**
 * Replace the text content of a shape's text body. Preserves the first
 * paragraph's pPr and the first run's rPr so existing formatting carries
 * over to the new text. Newlines split into separate paragraphs.
 */
export const editShapeText = (slideXml: string, shapeId: string, newText: string): string => {
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

  const lines = newText.split('\n');
  for (const line of lines) {
    const p = doc.createElementNS(A_NS, 'a:p');
    if (preservedPPr) p.appendChild(preservedPPr.cloneNode(true));

    const r = doc.createElementNS(A_NS, 'a:r');
    if (preservedRPr) r.appendChild(preservedRPr.cloneNode(true));

    const t = doc.createElementNS(A_NS, 'a:t');
    t.textContent = line;
    r.appendChild(t);
    p.appendChild(r);
    txBody.appendChild(p);
  }

  return serializeXml(doc);
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
const findSpTree = (doc: Document): Element | undefined => {
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

const normalizeHex = (hex: string, label: string): string => {
  const normalized = hex.replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    throw ToolError.validation(`Invalid ${label} color: ${hex} — expected 6 hex digits`);
  }
  return normalized;
};

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
    if (fmt.color) {
      const normalized = normalizeHex(fmt.color, 'text');
      const solidFill = doc.createElementNS(A_NS, 'a:solidFill');
      const srgb = doc.createElementNS(A_NS, 'a:srgbClr');
      srgb.setAttribute('val', normalized);
      solidFill.appendChild(srgb);
      rPr.appendChild(solidFill);
    }
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
  fillHex: string | undefined,
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

  if (fillHex !== undefined) {
    const normalized = normalizeHex(fillHex, 'fill');
    const solidFill = doc.createElementNS(A_NS, 'a:solidFill');
    const srgb = doc.createElementNS(A_NS, 'a:srgbClr');
    srgb.setAttribute('val', normalized);
    solidFill.appendChild(srgb);
    spPr.appendChild(solidFill);
  }
};

/** Get the largest cNvPr id currently in use anywhere in the document. */
const getMaxCNvPrId = (doc: Document): number => {
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

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

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
    entries.set(newRelsPath, TEXT_ENCODER.encode(serializeXml(relsDoc)));
  }

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
  const walker = presDoc.createTreeWalker(presDoc, NodeFilter.SHOW_ELEMENT);
  let sldIdLst: Element | undefined;
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === 'sldIdLst') {
      sldIdLst = node;
      break;
    }
    node = walker.nextNode();
  }
  if (!sldIdLst) throw ToolError.internal('presentation.xml has no sldIdLst');

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
    total_slides: slideFiles.length + 1,
  };
};
