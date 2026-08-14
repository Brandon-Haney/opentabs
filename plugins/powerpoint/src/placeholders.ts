/**
 * The placeholder model: a slide as a set of named slots rather than a canvas.
 *
 * A person filling in a slide names the part they mean — "the title", "the
 * bullets" — and never thinks about which shape happens to sit where. OOXML
 * supports that directly: a slide built from a layout carries one `<p:ph>` per
 * slot the layout defines, and the slot, not the position, is the identity.
 * This module maps between the two, so tools can take a role and resolve it to
 * the shape that serves it.
 *
 * The rules encoded here come from the OOXML schema, not from convention:
 * - `idx` identifies a placeholder, `type` only describes it. A two-content
 *   layout has two `body` placeholders distinguished by nothing but `idx`.
 * - A `<p:ph>` with no `type` is a body placeholder; that is the schema default.
 * - A `<p:ph>` with no `idx` is index 0, which is why the title — the one slot
 *   that usually states no index — resolves consistently.
 */

import { ToolError } from '@opentabs-dev/plugin-sdk';
import { getRelatedParts, TEXT_DECODER } from './pptx-utils.js';
import type { ShapeNode } from './slide-layout.js';
import { A_NS, childByLocalName, childElements, descendantsByLocalName, P_NS, parseXml } from './xml.js';

/**
 * The slot a caller names when reading or writing a slide.
 *
 * These are the roles a person recognises, not the raw OOXML type list. A
 * title-slide's centred title is still "the title", and the content area of a
 * stock layout is "the body" whether the schema calls it `body`, `obj`, or
 * leaves it untyped — so each role covers the set of types that serve it.
 */
export type SlotRole = 'title' | 'subtitle' | 'body';

const ROLE_TYPES: Record<SlotRole, ReadonlySet<string>> = {
  title: new Set(['title', 'ctrTitle']),
  subtitle: new Set(['subTitle']),
  body: new Set(['body', 'obj', '']),
};

export const SLOT_ROLES = Object.keys(ROLE_TYPES) as SlotRole[];

/** The role a placeholder type serves, or undefined for date/footer/slide-number furniture. */
export const roleForPlaceholderType = (placeholderType: string): SlotRole | undefined =>
  SLOT_ROLES.find(role => ROLE_TYPES[role].has(placeholderType));

/**
 * Placeholder types worth carrying onto a new slide.
 *
 * Date, footer, and slide-number placeholders are deliberately excluded: they
 * are rendered from the layout and master, and copying them onto the slide
 * produces empty duplicates over the real ones.
 */
export const isCloneablePlaceholderType = (placeholderType: string): boolean =>
  roleForPlaceholderType(placeholderType) !== undefined;

/** Human-readable name stem per placeholder type, mirroring PowerPoint's own naming. */
const NAME_STEM: Record<string, string> = {
  '': 'Content Placeholder',
  obj: 'Content Placeholder',
  body: 'Text Placeholder',
  title: 'Title',
  ctrTitle: 'Title',
  subTitle: 'Subtitle',
};

/** The `<p:ph>` attributes that define a placeholder slot. */
export interface PlaceholderSpec {
  /** `<p:ph type>`, empty string when absent — which the schema reads as `body`. */
  type: string;
  /** `<p:ph idx>`, defaulting to 0 when absent. */
  idx: number;
  /** `<p:ph sz>` — the size class a body placeholder inherits its text scale from. */
  sz: string | null;
  /** `<p:ph orient>` — vertical placeholders in East Asian layouts. */
  orient: string | null;
}

/** Read a `<p:ph>` element into a spec. */
const readPlaceholderSpec = (ph: Element): PlaceholderSpec => {
  const rawIdx = ph.getAttribute('idx');
  const parsed = rawIdx === null ? Number.NaN : Number.parseInt(rawIdx, 10);
  return {
    type: ph.getAttribute('type') ?? '',
    idx: Number.isNaN(parsed) ? 0 : parsed,
    sz: ph.getAttribute('sz'),
    orient: ph.getAttribute('orient'),
  };
};

/**
 * The cloneable placeholder slots a slide layout defines.
 *
 * Only the layout's own top-level shapes are considered. A layout part can
 * carry `<p:ph>` elements deeper down — inside a group, or in the layout's own
 * `<p:hf>` header/footer block — and a subtree search would return slots that
 * are not slide-level at all.
 */
export const readLayoutSlots = (layoutXml: string): PlaceholderSpec[] => {
  const root = parseXml(layoutXml).documentElement;
  if (!root) return [];
  const spTree = descendantsByLocalName(root, 'spTree')[0];
  if (!spTree) return [];

  const specs: PlaceholderSpec[] = [];
  const seen = new Set<number>();
  for (const shape of childElements(spTree)) {
    const nvSpPr = childByLocalName(shape, 'nvSpPr');
    const nvPr = nvSpPr ? childByLocalName(nvSpPr, 'nvPr') : undefined;
    const ph = nvPr ? childByLocalName(nvPr, 'ph') : undefined;
    if (!ph) continue;
    const spec = readPlaceholderSpec(ph);
    // A malformed layout can repeat an index; the first wins, because a
    // duplicate would otherwise produce two slide shapes sharing one identity.
    if (!isCloneablePlaceholderType(spec.type) || seen.has(spec.idx)) continue;
    seen.add(spec.idx);
    specs.push(spec);
  }
  return specs;
};

/** A slot on a slide, resolved against the layout that defines it. */
export interface SlideSlot {
  role: SlotRole;
  /** The raw OOXML placeholder type, for callers that need the distinction. */
  placeholder_type: string;
  idx: number;
  /** The shape serving this slot, or null when the layout defines it and the slide has no shape for it. */
  shape_id: string | null;
  name: string;
  /** Geometry in inches, resolved through the layout and master. Zero when the slot is absent from the slide. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The slot's text, paragraphs joined by newline. */
  text: string;
  /**
   * Typeface stated on the slot's first run, when it states one.
   *
   * Undefined means the text inherits its face from the layout or theme, which
   * is the usual case — a caller measuring the text should fall back to a
   * default rather than guess at the theme.
   */
  font?: string;
}

/** Flatten a shape's parsed paragraphs back to plain text, one line per paragraph. */
export const shapeText = (shape: ShapeNode): string =>
  (shape.text ?? []).map(p => p.runs.map(r => r.text).join('')).join('\n');

/** The typeface the shape's first run states, if any. */
const shapeFont = (shape: ShapeNode): string | undefined => shape.text?.[0]?.runs?.[0]?.font;

/**
 * Resolve a slide's shapes and its layout's slots into one list of named slots.
 *
 * Layout slots the slide carries no shape for are included with a null
 * `shape_id`: they are real slots a caller can still write to — PowerPoint
 * shows them as "Click to add title" — and omitting them would report a slide
 * as having no title when it simply has an untouched one.
 */
export const resolveSlots = (shapes: ShapeNode[], layoutSlots: PlaceholderSpec[]): SlideSlot[] => {
  const slots: SlideSlot[] = [];
  const filled = new Set<number>();

  for (const shape of shapes) {
    if (shape.placeholder_type === undefined || shape.placeholder_idx === undefined) continue;
    const role = roleForPlaceholderType(shape.placeholder_type);
    if (!role) continue;
    filled.add(shape.placeholder_idx);
    slots.push({
      role,
      placeholder_type: shape.placeholder_type,
      idx: shape.placeholder_idx,
      shape_id: shape.id,
      name: shape.name,
      x: shape.x,
      y: shape.y,
      w: shape.w,
      h: shape.h,
      text: shapeText(shape),
      font: shapeFont(shape),
    });
  }

  for (const spec of layoutSlots) {
    if (filled.has(spec.idx)) continue;
    const role = roleForPlaceholderType(spec.type);
    if (!role) continue;
    slots.push({
      role,
      placeholder_type: spec.type,
      idx: spec.idx,
      shape_id: null,
      name: NAME_STEM[spec.type] ?? 'Placeholder',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      text: '',
    });
  }

  return slots.sort((a, b) => a.idx - b.idx);
};

/**
 * Find the one slot serving `role`, or say precisely why it could not.
 *
 * When a layout offers several slots of the same role — a two-content layout
 * has two bodies — naming the role alone is ambiguous, and picking the first
 * would quietly write to whichever one happens to come first in document order.
 * The error names the indexes instead, so the caller can pass the one it meant.
 */
export const findSlot = (slots: SlideSlot[], role: SlotRole, idx?: number): SlideSlot => {
  const candidates = slots.filter(s => s.role === role && (idx === undefined || s.idx === idx));

  const first = candidates[0];
  if (!first) {
    const available = slots.length > 0 ? slots.map(s => `${s.role} (idx ${s.idx})`).join(', ') : 'none';
    throw ToolError.notFound(
      idx === undefined
        ? `This slide has no ${role} placeholder. Slots on this slide: ${available}.`
        : `This slide has no ${role} placeholder at idx ${idx}. Slots on this slide: ${available}.`,
    );
  }
  if (candidates.length > 1) {
    throw ToolError.validation(
      `This slide has ${candidates.length} ${role} placeholders (idx ${candidates.map(s => s.idx).join(', ')}). ` +
        `Pass idx to choose one.`,
    );
  }
  return first;
};

/** Font sizes in `<a:defRPr sz>` are hundredths of a point. */
const FONT_SIZE_UNITS_PER_PT = 100;

/** The master text-style element a role's text cascades through. */
const MASTER_STYLE_FOR_ROLE: Record<SlotRole, string> = {
  title: 'titleStyle',
  // A subtitle is styled as body text by the master, not as a second title.
  subtitle: 'bodyStyle',
  body: 'bodyStyle',
};

/** First-level `<a:defRPr sz>` under a list-style container, in points. */
const firstLevelDefaultSize = (lstStyle: Element | undefined): number | undefined => {
  const lvl1 = lstStyle ? childByLocalName(lstStyle, 'lvl1pPr') : undefined;
  const defRPr = lvl1 ? childByLocalName(lvl1, 'defRPr') : undefined;
  const sz = defRPr?.getAttribute('sz');
  if (!sz) return undefined;
  const parsed = Number.parseInt(sz, 10);
  return Number.isFinite(parsed) ? parsed / FONT_SIZE_UNITS_PER_PT : undefined;
};

/** The layout placeholder with this index, if the layout defines one. */
const layoutPlaceholderByIdx = (layoutXml: string, idx: number): Element | undefined => {
  const root = parseXml(layoutXml).documentElement;
  if (!root) return undefined;
  const spTree = descendantsByLocalName(root, 'spTree')[0];
  if (!spTree) return undefined;
  return childElements(spTree).find(shape => {
    const nvSpPr = childByLocalName(shape, 'nvSpPr');
    const nvPr = nvSpPr ? childByLocalName(nvSpPr, 'nvPr') : undefined;
    const ph = nvPr ? childByLocalName(nvPr, 'ph') : undefined;
    return ph !== undefined && readPlaceholderSpec(ph).idx === idx;
  });
};

/**
 * The font size a slot's text takes when no run states one, in points.
 *
 * Resolution follows the OOXML cascade: the layout placeholder's own list style,
 * then the master's text styles for that slot's class, then the presentation
 * default. It matters because shrink-to-fit must only ever *shrink* — fitting
 * text to a box without knowing the inherited size would enlarge a short title
 * until it filled its placeholder, silently overriding the deck's design.
 *
 * Returns undefined when the deck states no default anywhere, leaving the choice
 * of a fallback to the caller rather than inventing one here.
 */
export const resolveSlotFontSize = (
  entries: Map<string, Uint8Array>,
  slideFile: string,
  role: SlotRole,
  idx: number,
): number | undefined => {
  const layoutPart = getRelatedParts(entries, slideFile, '/slideLayout')[0];
  const layoutData = layoutPart ? entries.get(layoutPart) : undefined;

  if (layoutData) {
    const placeholder = layoutPlaceholderByIdx(TEXT_DECODER.decode(layoutData), idx);
    const txBody = placeholder ? childByLocalName(placeholder, 'txBody') : undefined;
    const fromLayout = firstLevelDefaultSize(txBody ? childByLocalName(txBody, 'lstStyle') : undefined);
    if (fromLayout !== undefined) return fromLayout;
  }

  const masterPart = layoutPart ? getRelatedParts(entries, layoutPart, '/slideMaster')[0] : undefined;
  const masterData = masterPart ? entries.get(masterPart) : undefined;
  if (masterData) {
    const root = parseXml(TEXT_DECODER.decode(masterData)).documentElement;
    const txStyles = root ? childByLocalName(root, 'txStyles') : undefined;
    const fromMaster = firstLevelDefaultSize(
      txStyles ? childByLocalName(txStyles, MASTER_STYLE_FOR_ROLE[role]) : undefined,
    );
    if (fromMaster !== undefined) return fromMaster;
  }

  const presData = entries.get('ppt/presentation.xml');
  if (presData) {
    const root = parseXml(TEXT_DECODER.decode(presData)).documentElement;
    return firstLevelDefaultSize(root ? childByLocalName(root, 'defaultTextStyle') : undefined);
  }
  return undefined;
};

/**
 * Append an empty placeholder shape to a slide's `<p:spTree>`.
 *
 * Only `type`, `idx`, `sz`, and `orient` are carried across from the layout —
 * never position, size, or text. Omitting `<a:xfrm>` is precisely what makes the
 * placeholder inherit its geometry from the layout slot sharing its `idx`, which
 * is how PowerPoint itself represents an untouched placeholder; writing an
 * explicit box here would sever that link and freeze the slide against later
 * layout changes.
 */
export const appendPlaceholder = (
  spTree: Element,
  spec: PlaceholderSpec,
  shapeId: number,
  ordinal: number,
): Element => {
  const doc = spTree.ownerDocument;
  if (!doc) throw ToolError.internal('spTree has no owner document');

  const sp = doc.createElementNS(P_NS, 'p:sp');

  const nvSpPr = doc.createElementNS(P_NS, 'p:nvSpPr');
  const cNvPr = doc.createElementNS(P_NS, 'p:cNvPr');
  cNvPr.setAttribute('id', String(shapeId));
  cNvPr.setAttribute('name', `${NAME_STEM[spec.type] ?? 'Placeholder'} ${ordinal}`);
  nvSpPr.appendChild(cNvPr);

  const cNvSpPr = doc.createElementNS(P_NS, 'p:cNvSpPr');
  const spLocks = doc.createElementNS(A_NS, 'a:spLocks');
  spLocks.setAttribute('noGrp', '1');
  cNvSpPr.appendChild(spLocks);
  nvSpPr.appendChild(cNvSpPr);

  const nvPr = doc.createElementNS(P_NS, 'p:nvPr');
  const ph = doc.createElementNS(P_NS, 'p:ph');
  if (spec.type) ph.setAttribute('type', spec.type);
  if (spec.orient) ph.setAttribute('orient', spec.orient);
  if (spec.sz) ph.setAttribute('sz', spec.sz);
  // Index 0 is the schema default and PowerPoint omits it, so a title written
  // with an explicit idx="0" reads as hand-authored where it should not.
  if (spec.idx !== 0) ph.setAttribute('idx', String(spec.idx));
  nvPr.appendChild(ph);
  nvSpPr.appendChild(nvPr);
  sp.appendChild(nvSpPr);

  sp.appendChild(doc.createElementNS(P_NS, 'p:spPr'));

  const txBody = doc.createElementNS(P_NS, 'p:txBody');
  txBody.appendChild(doc.createElementNS(A_NS, 'a:bodyPr'));
  txBody.appendChild(doc.createElementNS(A_NS, 'a:lstStyle'));
  txBody.appendChild(doc.createElementNS(A_NS, 'a:p'));
  sp.appendChild(txBody);

  spTree.appendChild(sp);
  return sp;
};
