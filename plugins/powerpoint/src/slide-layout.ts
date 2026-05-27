/**
 * Structural parser for PowerPoint slide XML (OOXML / DrawingML).
 *
 * Walks the `<p:spTree>` of a slide and converts each shape element into a
 * JSON tree with position, size, rotation, fill, and text formatting. All
 * coordinates are converted from EMUs (914,400 per inch) to inches so agents
 * can reason in human-friendly units.
 *
 * Phase 1 (read-only perception): returns enough detail for an agent to
 * understand the slide layout and map visual intent ("the yellow box on the
 * right") to a specific shape id for future edit tools.
 */

import { ToolError } from '@opentabs-dev/plugin-sdk';
import { TEXT_DECODER } from './pptx-utils.js';

// --- Units ---

const EMU_PER_INCH = 914400;
/** Rotation in OOXML is stored as 60,000ths of a degree. */
const ROT_UNITS_PER_DEG = 60000;
/** Font sizes in <a:rPr sz="..."> are hundredths of a point. */
const FONT_SIZE_UNITS_PER_PT = 100;

const emuToInches = (emu: number): number => Math.round((emu / EMU_PER_INCH) * 1000) / 1000;

// --- Types ---

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Font size in points. */
  size?: number;
  font?: string;
  /** Hex color (e.g. "FFCC00") or "scheme:accent1" for theme colors. */
  color?: string;
}

export interface TextParagraph {
  runs: TextRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Indent level (0 = top level). */
  level?: number;
}

export type ShapeKind =
  | 'textbox'
  | 'shape'
  | 'placeholder'
  | 'picture'
  | 'group'
  | 'table'
  | 'chart'
  | 'graphicFrame'
  | 'connector';

export interface ShapeNode {
  /** Unique identifier within the slide (from `<p:cNvPr id="...">`). */
  id: string;
  /** Human-readable name (from `<p:cNvPr name="...">`). */
  name: string;
  kind: ShapeKind;
  /** Preset geometry name for shapes ("rect", "ellipse", "roundRect", ...). */
  preset?: string;
  /** Placeholder type for placeholder shapes ("title", "body", "ctrTitle", ...). */
  placeholder_type?: string;
  /** Position/size in inches. May be 0 when inherited from a layout/master. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in degrees (positive = clockwise). */
  rotation?: number;
  /** Solid fill color — hex (e.g. "FFCC00") or "scheme:<name>" for theme refs. */
  fill?: string;
  /** Text content organized as paragraphs with per-run formatting. */
  text?: TextParagraph[];
  /** Relationship id of the embedded image (picture shapes only). */
  image_rel?: string;
  /** Child shapes for group shapes. */
  children?: ShapeNode[];
  /** True when position/size were not found on the shape itself (inherited). */
  inherited_geometry?: boolean;
}

export interface SlideLayout {
  slide_number: number;
  /** Slide canvas width in inches. */
  width: number;
  /** Slide canvas height in inches. */
  height: number;
  shapes: ShapeNode[];
}

// --- DOM helpers (namespace-agnostic via localName) ---

const xmlParser = typeof DOMParser !== 'undefined' ? new DOMParser() : undefined;

const parseXml = (xml: string): Document => {
  if (!xmlParser) throw ToolError.internal('DOMParser not available');
  return xmlParser.parseFromString(xml, 'application/xml');
};

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

const childElements = (el: Element): Element[] => {
  const out: Element[] = [];
  for (const n of el.childNodes) if (isElement(n)) out.push(n);
  return out;
};

/** First direct child with the given local name, ignoring namespace prefix. */
const childByLocalName = (el: Element, localName: string): Element | undefined =>
  childElements(el).find(c => c.localName === localName);

/** All descendants with the given local name (document order). */
const descendantsByLocalName = (root: Element | Document, localName: string): Element[] => {
  const results: Element[] = [];
  const walker =
    'createTreeWalker' in root
      ? (root as Document).createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT)
      : (root.ownerDocument as Document).createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === localName) results.push(node);
    node = walker.nextNode();
  }
  return results;
};

/** First descendant with the given local name. */
const firstDescendantByLocalName = (root: Element, localName: string): Element | undefined => {
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  if (!walker) return undefined;
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === localName) return node;
    node = walker.nextNode();
  }
  return undefined;
};

// --- Geometry parsing ---

interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  found: boolean;
}

/** Parse an `<a:xfrm>` element into inches + degrees. */
const parseXfrm = (xfrm: Element | undefined): Xfrm => {
  if (!xfrm) return { x: 0, y: 0, w: 0, h: 0, found: false };
  const off = childByLocalName(xfrm, 'off');
  const ext = childByLocalName(xfrm, 'ext');
  const x = Number.parseInt(off?.getAttribute('x') ?? '0', 10);
  const y = Number.parseInt(off?.getAttribute('y') ?? '0', 10);
  const cx = Number.parseInt(ext?.getAttribute('cx') ?? '0', 10);
  const cy = Number.parseInt(ext?.getAttribute('cy') ?? '0', 10);
  const rotAttr = xfrm.getAttribute('rot');
  const rot = rotAttr ? Number.parseInt(rotAttr, 10) / ROT_UNITS_PER_DEG : undefined;
  return {
    x: emuToInches(x),
    y: emuToInches(y),
    w: emuToInches(cx),
    h: emuToInches(cy),
    rotation: rot,
    found: !!(off || ext),
  };
};

// --- Fill parsing ---

/** Parse the first `<a:solidFill>` under `spPr` into a color string. */
const parseSolidFill = (spPr: Element | undefined): string | undefined => {
  if (!spPr) return undefined;
  const solidFill = childByLocalName(spPr, 'solidFill');
  if (!solidFill) return undefined;
  const srgb = childByLocalName(solidFill, 'srgbClr');
  if (srgb) return srgb.getAttribute('val') ?? undefined;
  const scheme = childByLocalName(solidFill, 'schemeClr');
  if (scheme) return `scheme:${scheme.getAttribute('val') ?? ''}`;
  const prstClr = childByLocalName(solidFill, 'prstClr');
  if (prstClr) return `preset:${prstClr.getAttribute('val') ?? ''}`;
  return undefined;
};

// --- Text parsing ---

const parseRunProperties = (rPr: Element | undefined): Omit<TextRun, 'text'> => {
  if (!rPr) return {};
  const props: Omit<TextRun, 'text'> = {};
  if (rPr.getAttribute('b') === '1') props.bold = true;
  if (rPr.getAttribute('i') === '1') props.italic = true;
  const u = rPr.getAttribute('u');
  if (u && u !== 'none') props.underline = true;
  const sz = rPr.getAttribute('sz');
  if (sz) props.size = Number.parseInt(sz, 10) / FONT_SIZE_UNITS_PER_PT;
  const latin = childByLocalName(rPr, 'latin');
  const face = latin?.getAttribute('typeface');
  if (face) props.font = face;
  const color = parseSolidFill(rPr);
  if (color) props.color = color;
  return props;
};

const parseParagraph = (p: Element): TextParagraph => {
  const runs: TextRun[] = [];
  let align: TextParagraph['align'];
  let level: number | undefined;

  const pPr = childByLocalName(p, 'pPr');
  if (pPr) {
    const algn = pPr.getAttribute('algn');
    if (algn === 'l') align = 'left';
    else if (algn === 'ctr') align = 'center';
    else if (algn === 'r') align = 'right';
    else if (algn === 'just') align = 'justify';
    const lvl = pPr.getAttribute('lvl');
    if (lvl) level = Number.parseInt(lvl, 10);
  }

  for (const child of childElements(p)) {
    if (child.localName === 'r') {
      const rPr = childByLocalName(child, 'rPr');
      const t = childByLocalName(child, 't');
      const text = t?.textContent ?? '';
      runs.push({ text, ...parseRunProperties(rPr) });
    } else if (child.localName === 'br') {
      runs.push({ text: '\n' });
    } else if (child.localName === 'fld') {
      // Field (date, slide number, etc) — treat as run
      const t = childByLocalName(child, 't');
      if (t?.textContent) runs.push({ text: t.textContent });
    }
  }

  const para: TextParagraph = { runs };
  if (align) para.align = align;
  if (level !== undefined) para.level = level;
  return para;
};

const parseTextBody = (txBody: Element | undefined): TextParagraph[] | undefined => {
  if (!txBody) return undefined;
  const paragraphs: TextParagraph[] = [];
  for (const child of childElements(txBody)) {
    if (child.localName === 'p') paragraphs.push(parseParagraph(child));
  }
  return paragraphs.length > 0 ? paragraphs : undefined;
};

// --- Shape element dispatch ---

interface ShapeCommon {
  id: string;
  name: string;
  placeholderType?: string;
  isTextBox: boolean;
}

/** Extract common identity from an `<p:nvSpPr>` or `<p:nvPicPr>` block. */
const parseNvProps = (nvProps: Element | undefined): ShapeCommon => {
  if (!nvProps) return { id: '', name: '', isTextBox: false };
  const cNvPr = childByLocalName(nvProps, 'cNvPr');
  const id = cNvPr?.getAttribute('id') ?? '';
  const name = cNvPr?.getAttribute('name') ?? '';
  const cNvSpPr = childByLocalName(nvProps, 'cNvSpPr');
  const isTextBox = cNvSpPr?.getAttribute('txBox') === '1';
  const nvPr = childByLocalName(nvProps, 'nvPr');
  const ph = nvPr ? childByLocalName(nvPr, 'ph') : undefined;
  const placeholderType = ph?.getAttribute('type') ?? (ph ? 'body' : undefined);
  return { id, name, placeholderType, isTextBox };
};

const parseSp = (sp: Element): ShapeNode => {
  const nvSpPr = childByLocalName(sp, 'nvSpPr');
  const spPr = childByLocalName(sp, 'spPr');
  const txBody = childByLocalName(sp, 'txBody');
  const common = parseNvProps(nvSpPr);
  const xfrm = parseXfrm(spPr ? childByLocalName(spPr, 'xfrm') : undefined);
  const prstGeom = spPr ? childByLocalName(spPr, 'prstGeom') : undefined;
  const preset = prstGeom?.getAttribute('prst') ?? undefined;
  const fill = parseSolidFill(spPr);
  const text = parseTextBody(txBody);

  let kind: ShapeKind;
  if (common.placeholderType) kind = 'placeholder';
  else if (common.isTextBox) kind = 'textbox';
  else kind = 'shape';

  const node: ShapeNode = {
    id: common.id,
    name: common.name,
    kind,
    x: xfrm.x,
    y: xfrm.y,
    w: xfrm.w,
    h: xfrm.h,
  };
  if (preset) node.preset = preset;
  if (common.placeholderType) node.placeholder_type = common.placeholderType;
  if (xfrm.rotation !== undefined && xfrm.rotation !== 0) node.rotation = xfrm.rotation;
  if (fill) node.fill = fill;
  if (text) node.text = text;
  if (!xfrm.found) node.inherited_geometry = true;
  return node;
};

const parsePic = (pic: Element): ShapeNode => {
  const nvPicPr = childByLocalName(pic, 'nvPicPr');
  const spPr = childByLocalName(pic, 'spPr');
  const blipFill = childByLocalName(pic, 'blipFill');
  const common = parseNvProps(nvPicPr);
  const xfrm = parseXfrm(spPr ? childByLocalName(spPr, 'xfrm') : undefined);

  let imageRel: string | undefined;
  if (blipFill) {
    const blip = childByLocalName(blipFill, 'blip');
    // r:embed attribute — TreeWalker preserves namespace-prefixed attributes as-is
    imageRel =
      blip?.getAttribute('r:embed') ??
      blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ??
      undefined;
  }

  const node: ShapeNode = {
    id: common.id,
    name: common.name,
    kind: 'picture',
    x: xfrm.x,
    y: xfrm.y,
    w: xfrm.w,
    h: xfrm.h,
  };
  if (xfrm.rotation !== undefined && xfrm.rotation !== 0) node.rotation = xfrm.rotation;
  if (imageRel) node.image_rel = imageRel;
  if (!xfrm.found) node.inherited_geometry = true;
  return node;
};

const parseGraphicFrame = (frame: Element): ShapeNode => {
  const nv = childByLocalName(frame, 'nvGraphicFramePr');
  const xfrmEl = childByLocalName(frame, 'xfrm');
  const xfrm = parseXfrm(xfrmEl);
  const common = parseNvProps(nv);

  // Distinguish table vs chart vs generic graphicFrame by scanning descendants.
  let kind: ShapeKind = 'graphicFrame';
  const graphic = childByLocalName(frame, 'graphic');
  const data = graphic ? childByLocalName(graphic, 'graphicData') : undefined;
  const uri = data?.getAttribute('uri') ?? '';
  if (uri.includes('/table')) kind = 'table';
  else if (uri.includes('/chart')) kind = 'chart';

  const node: ShapeNode = {
    id: common.id,
    name: common.name,
    kind,
    x: xfrm.x,
    y: xfrm.y,
    w: xfrm.w,
    h: xfrm.h,
  };
  if (xfrm.rotation !== undefined && xfrm.rotation !== 0) node.rotation = xfrm.rotation;
  if (!xfrm.found) node.inherited_geometry = true;
  return node;
};

const parseConnector = (cxn: Element): ShapeNode => {
  const nv = childByLocalName(cxn, 'nvCxnSpPr');
  const spPr = childByLocalName(cxn, 'spPr');
  const common = parseNvProps(nv);
  const xfrm = parseXfrm(spPr ? childByLocalName(spPr, 'xfrm') : undefined);
  const prstGeom = spPr ? childByLocalName(spPr, 'prstGeom') : undefined;

  const node: ShapeNode = {
    id: common.id,
    name: common.name,
    kind: 'connector',
    x: xfrm.x,
    y: xfrm.y,
    w: xfrm.w,
    h: xfrm.h,
  };
  const preset = prstGeom?.getAttribute('prst');
  if (preset) node.preset = preset;
  if (xfrm.rotation !== undefined && xfrm.rotation !== 0) node.rotation = xfrm.rotation;
  if (!xfrm.found) node.inherited_geometry = true;
  return node;
};

const parseGroup = (grp: Element): ShapeNode => {
  const nvGrpSpPr = childByLocalName(grp, 'nvGrpSpPr');
  const grpSpPr = childByLocalName(grp, 'grpSpPr');
  const common = parseNvProps(nvGrpSpPr);
  const xfrm = parseXfrm(grpSpPr ? childByLocalName(grpSpPr, 'xfrm') : undefined);

  const children: ShapeNode[] = [];
  for (const child of childElements(grp)) {
    const node = parseShapeElement(child);
    if (node) children.push(node);
  }

  const node: ShapeNode = {
    id: common.id,
    name: common.name,
    kind: 'group',
    x: xfrm.x,
    y: xfrm.y,
    w: xfrm.w,
    h: xfrm.h,
    children,
  };
  if (xfrm.rotation !== undefined && xfrm.rotation !== 0) node.rotation = xfrm.rotation;
  if (!xfrm.found) node.inherited_geometry = true;
  return node;
};

const parseShapeElement = (el: Element): ShapeNode | null => {
  switch (el.localName) {
    case 'sp':
      return parseSp(el);
    case 'pic':
      return parsePic(el);
    case 'graphicFrame':
      return parseGraphicFrame(el);
    case 'cxnSp':
      return parseConnector(el);
    case 'grpSp':
      return parseGroup(el);
    default:
      return null;
  }
};

// --- Entry points ---

/** Parse the `<p:sldSz>` from presentation.xml into inches. */
export const getSlideSize = (entries: Map<string, Uint8Array>): { width: number; height: number } => {
  const data = entries.get('ppt/presentation.xml');
  if (!data) return { width: 13.333, height: 7.5 }; // 16:9 default
  const xml = TEXT_DECODER.decode(data);
  const doc = parseXml(xml);
  const sldSz = descendantsByLocalName(doc, 'sldSz')[0];
  if (!sldSz) return { width: 13.333, height: 7.5 };
  const cx = Number.parseInt(sldSz.getAttribute('cx') ?? '0', 10);
  const cy = Number.parseInt(sldSz.getAttribute('cy') ?? '0', 10);
  return { width: emuToInches(cx), height: emuToInches(cy) };
};

/** Parse a single slide XML into a structured layout tree. */
export const parseSlideLayout = (
  slideXml: string,
  slideNumber: number,
  canvas: { width: number; height: number },
): SlideLayout => {
  const doc = parseXml(slideXml);
  const root = doc.documentElement;
  if (!root) throw ToolError.internal('Empty slide XML');
  const cSld = firstDescendantByLocalName(root, 'cSld');
  const spTree = cSld ? childByLocalName(cSld, 'spTree') : undefined;
  if (!spTree) throw ToolError.internal('Slide XML has no spTree');

  const shapes: ShapeNode[] = [];
  for (const child of childElements(spTree)) {
    const node = parseShapeElement(child);
    if (node) shapes.push(node);
  }

  return {
    slide_number: slideNumber,
    width: canvas.width,
    height: canvas.height,
    shapes,
  };
};
