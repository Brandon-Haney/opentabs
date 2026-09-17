/**
 * Pods shape layout actions — read where shapes sit, move, resize, duplicate and
 * recolour them, and set a table's height, live in an OPEN deck.
 *
 * Decoded from the editor on the test deck (2026-09-17):
 *
 * - **Geometry units.** A shape's left, top, width and height (`335551508`,
 *   `335551509`, `335551515`, `335551516`) are in half-inches: a 11.32" × 5.72"
 *   table frame reads 22.64 × 11.44. `335563038`/`335563037` mirror left/top.
 * - **`MoveShapes`** resubmits the shape with new absolute left/top — both pairs.
 * - **`ResizeShapes`** does NOT send the new size. It resubmits the shape with an
 *   edge-delta instruction (`469780600`, `{"EastDelta":20,…}`) in 90-dpi pixels
 *   and the server applies it; the size properties keep their old values.
 * - **`DuplicateShape`** resubmits the slide with the copy appended to its shape
 *   list, and writes the copy: the shape, its text body and paragraphs, and its
 *   paragraph-level style objects (`131073`, listed in `603995142`). Runs are
 *   shared, not copied. The copy carries back-references to its slide
 *   (`536889494`) and to the shape it was copied from (`536889495`).
 * - **`ApplyShapeFillColor`** is two chained revisions, both resubmitting the shape
 *   with the solid fill (`469780718`) set and its style colour (`469780771`)
 *   cleared; the second also carries the colour-picker record (`469780594`).
 * - **`SetTableHeight`** rescales every row's height (`335562771`, half-inches);
 *   the table and its frame are not written. Rows never render shorter than their
 *   text, so a height below the content's needs smaller text to take effect.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { locateTableRow } from './pods-action-table-row.js';
import type { PodsMint, PodsReadActionSpec, PodsWriteActionSpec } from './pods-actions.js';
import { sortPropertiesById } from './pods-bridge.js';
import {
  actionDescIdOf,
  CLASS_PARAGRAPH,
  CLASS_RENDER_SHAPE,
  CLASS_SLIDE,
  CLASS_TEXT_BODY,
  cellIdOf,
  findSlideAt,
  isOnSlide,
  type PodsModel,
  type PodsObject,
  PROP_CONTENT_REFS,
  PROP_ORDERED_CHILDREN,
  PROP_SHAPE_NAME,
  PROP_TEXT,
  parseRefList,
  readProp,
  refToObjectId,
} from './pods-model.js';
import {
  CLASS_TABLE,
  CLASS_TABLE_ROW,
  copyWith,
  PROP_BLOCK_OWNER,
  PROP_LAST_MODIFIED_TIME,
  TEXT_BLOCK_CLASSES,
} from './pods-text-block.js';

/** Geometry properties, in half-inches. */
const PROP_LEFT = 335551508;
const PROP_TOP = 335551509;
const PROP_WIDTH = 335551515;
const PROP_HEIGHT = 335551516;
const PROP_LEFT_MIRROR = 335563038;
const PROP_TOP_MIRROR = 335563037;
/** The edge-delta instruction a resize carries, in 90-dpi pixels. */
const PROP_RESIZE_DELTA = 469780600;
/** A shape's solid fill, as `{"solidFillField":{"srgbClrField":{…"valField":[r,g,b]}}}`. */
const PROP_FILL = 469780718;
/** The shape id the server assigns; a new shape is written with `"0"`. */
const PROP_SHAPE_ID = 335562753;
/** A shape's creation guid, `{UPPERCASE-GUID}`. */
const PROP_CREATION_GUID = 469780944;
/** The author stamp of the last hand edit; a copy is written without it. */
const PROP_AUTHOR_STAMP = 469780706;
/** A shape's paragraph-level style objects (`131073`), in order. */
const PROP_LEVEL_STYLES = 603995142;
/** Back-reference from a copied object to its slide. */
const PROP_SLIDE_BACKREF = 536889494;
/** Back-reference from a copied shape to its source, and from its text to the copy. */
const PROP_OWNER_BACKREF = 536889495;
/** A table row's height, in half-inches. */
const PROP_ROW_HEIGHT = 335562771;

const CLASS_LEVEL_STYLE = 131073;
const UNITS_PER_INCH = 2;
const RESIZE_PIXELS_PER_INCH = 90;
/** Geometry read back within this many half-inches counts as applied (the server rounds). */
const GEOMETRY_TOLERANCE = 0.02;

/** ClassIds a model read must keep for shape layout actions. */
const SHAPE_CLASSES = [...TEXT_BLOCK_CLASSES, CLASS_SLIDE, CLASS_LEVEL_STYLE];

const numberProp = (properties: (string | number)[], id: number): number => Number(readProp(properties, id) ?? 'NaN');
const inches = (units: number): number => Math.round((units / UNITS_PER_INCH) * 1000) / 1000;

const lookup = (model: PodsModel, ref: string | undefined): PodsObject | undefined => {
  const id = ref ? refToObjectId(ref) : null;
  return id ? model.objects.find(o => o.objectId === id) : undefined;
};

/** The render shapes a slide lists, in its z-order. */
const shapesOnSlide = (model: PodsModel, slide: PodsObject): PodsObject[] =>
  parseRefList(readProp(slide.properties, PROP_CONTENT_REFS) ?? '')
    .map(ref => lookup(model, ref))
    .filter((o): o is PodsObject => o?.classId === CLASS_RENDER_SHAPE);

/** The visible text of a shape's text bodies, paragraphs joined by newlines. */
const shapeText = (model: PodsModel, shape: PodsObject): string =>
  parseRefList(readProp(shape.properties, PROP_CONTENT_REFS) ?? '')
    .map(ref => lookup(model, ref))
    .filter((o): o is PodsObject => o?.classId === CLASS_TEXT_BODY)
    .flatMap(body => parseRefList(readProp(body.properties, PROP_ORDERED_CHILDREN) ?? ''))
    .map(ref => lookup(model, ref))
    .map(paragraph => (paragraph ? (readProp(paragraph.properties, PROP_TEXT) ?? '') : ''))
    .filter(Boolean)
    .join('\n');

/**
 * A table's record of its frame's position, `"left,top"` in half-inches. It is how a
 * table is matched to its graphic frame: the frame's content reference names a
 * wrapper object the model read does not keep.
 */
const PROP_TABLE_FRAME_ORIGIN = 469780522;

/**
 * The table a shape frames, when it is a table's graphic frame: the table on the
 * frame's slide whose recorded frame origin is the frame's position. A frame still
 * lists an empty text body of its own, so a shape carrying visible text is never a
 * table frame, but one listing a body can be.
 */
const tableOf = (model: PodsModel, shape: PodsObject, slide: PodsObject): PodsObject | undefined => {
  if (shapeText(model, shape) !== '') return undefined;
  const tables = model.objects.filter(o => o.classId === CLASS_TABLE && isOnSlide(o, slide));
  const left = numberProp(shape.properties, PROP_LEFT);
  const top = numberProp(shape.properties, PROP_TOP);
  return tables.find(table => {
    const [x, y] = (readProp(table.properties, PROP_TABLE_FRAME_ORIGIN) ?? '').split(',').map(Number);
    return (
      Math.abs((x ?? Number.NaN) - left) <= GEOMETRY_TOLERANCE &&
      Math.abs((y ?? Number.NaN) - top) <= GEOMETRY_TOLERANCE
    );
  });
};

/** The fill colour as RRGGBB when it is a solid RGB fill. */
const fillHexOf = (shape: PodsObject): string | null => {
  const raw = readProp(shape.properties, PROP_FILL);
  if (!raw) return null;
  try {
    const rgb = JSON.parse(raw)?.solidFillField?.srgbClrField?.valField;
    if (!Array.isArray(rgb) || rgb.length !== 3) return null;
    return rgb
      .map((c: number) => c.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  } catch {
    return null;
  }
};

/** A shape located on a slide by name, with what a write to it needs. */
export interface LocatedShape {
  cellId: string;
  actionDescId: string;
  slide: PodsObject;
  slideRef: string;
  slideIndex: number;
  shape: PodsObject;
  name: string;
  occurrence: number;
}

/** Find the `occurrence`-th shape named `name` on slide `slideIndex`, naming the slide's shapes on a miss. */
export const locateShape = (model: PodsModel, slideIndex: number, name: string, occurrence = 1): LocatedShape => {
  const { slide, slideRef, root } = findSlideAt(model, slideIndex);
  const shapes = shapesOnSlide(model, slide);
  const named = shapes.filter(s => readProp(s.properties, PROP_SHAPE_NAME) === name);
  const shape = named[occurrence - 1];
  if (!shape) {
    const names = [...new Set(shapes.map(s => readProp(s.properties, PROP_SHAPE_NAME)).filter(Boolean))];
    throw new FrameBridgeValidationError(
      named.length === 0
        ? `Slide ${slideIndex} has no shape named "${name}". Its shapes: ${names.map(n => `"${n}"`).join(', ')}.`
        : `Slide ${slideIndex} has ${named.length} shape(s) named "${name}", so occurrence ${occurrence} does not exist.`,
    );
  }
  return {
    cellId: shape.cellId ?? cellIdOf(root),
    actionDescId: actionDescIdOf(root),
    slide,
    slideRef,
    slideIndex,
    shape,
    name,
    occurrence,
  };
};

/** A single-revision write body around `objects`. */
const singleRevision = (
  cellId: string,
  guidToken: string,
  headToken: string,
  sequence: number,
  objects: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  Mode: 4,
  srs: [
    [
      3,
      {
        OperationId: 1,
        DependentOn: 0,
        Revisions: [
          {
            Id: `${guidToken}|2`,
            FileId: null,
            RelativePath: null,
            CellId: cellId,
            ContextId: '00000000-0000-0000-0000-000000000000|0',
            ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
            BaseId: headToken,
            RootObjectDescriptors: null,
            ObjectGroups: [{ Id: `${guidToken}|3`, Objects: objects }],
            IsFolderCell: false,
          },
        ],
        ExpectedLatestId: headToken,
        Sequence: sequence,
        PutOnlyCall: false,
        LocalRenderingParams: null,
      },
    ],
  ],
});

const descriptor = (actionDescId: string, actionName: string, label: string, mint: PodsMint) => ({
  ObjectId: actionDescId,
  ClassId: 131140,
  Properties: [
    134236193,
    'true',
    335562934,
    '1',
    469780658,
    JSON.stringify({ ActionId: mint.seed, ActionName: actionName, ActionTime: mint.actionTime }),
    469780989,
    label,
  ],
});

const parseSlideShape = (
  raw: Record<string, unknown>,
  action: string,
): { slideIndex: number; shape: string; occurrence: number } => {
  if (typeof raw.slideIndex !== 'number' || !Number.isInteger(raw.slideIndex) || raw.slideIndex < 1) {
    throw new FrameBridgeValidationError(`${action} needs \`slideIndex\`: a 1-based slide position.`);
  }
  if (typeof raw.shape !== 'string' || raw.shape.length === 0) {
    throw new FrameBridgeValidationError(`${action} needs \`shape\`: the shape's name, as read_slide_layout lists it.`);
  }
  const occurrence = raw.occurrence ?? 1;
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
    throw new FrameBridgeValidationError(`${action} \`occurrence\` must be 1 or greater.`);
  }
  return { slideIndex: raw.slideIndex, shape: raw.shape, occurrence };
};

const optionalInches = (raw: unknown, field: string, action: string, allowNegative: boolean): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || (!allowNegative && raw <= 0)) {
    throw new FrameBridgeValidationError(
      `${action} \`${field}\` must be a ${allowNegative ? '' : 'positive '}number of inches.`,
    );
  }
  return raw;
};

// ---------------------------------------------------------------------------
// read_slide_layout

/** One shape on a slide, in inches from the slide's top-left corner. */
export interface ShapeLayout {
  name: string;
  /** 1-based among shapes with the same name on this slide. */
  occurrence: number;
  kind: 'table' | 'shape';
  left: number;
  top: number;
  width: number;
  height: number;
  fillHex: string | null;
  text: string;
  /** For a table: each row's height, and the text of its first cell. */
  rows?: Array<{ height: number; firstCell: string }>;
}

/** Reduce a slide to where each of its shapes sits. */
export const readSlideLayout = (model: PodsModel, slideIndex: number): Record<string, unknown> => {
  const { slide } = findSlideAt(model, slideIndex);
  const seen = new Map<string, number>();
  const shapes: ShapeLayout[] = shapesOnSlide(model, slide).map(shape => {
    const name = readProp(shape.properties, PROP_SHAPE_NAME) ?? '';
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    const table = tableOf(model, shape, slide);
    const layout: ShapeLayout = {
      name,
      occurrence,
      kind: table ? 'table' : 'shape',
      left: inches(numberProp(shape.properties, PROP_LEFT)),
      top: inches(numberProp(shape.properties, PROP_TOP)),
      width: inches(numberProp(shape.properties, PROP_WIDTH)),
      height: inches(numberProp(shape.properties, PROP_HEIGHT)),
      fillHex: fillHexOf(shape),
      text: table ? '' : shapeText(model, shape),
    };
    if (table) {
      layout.rows = parseRefList(readProp(table.properties, PROP_CONTENT_REFS) ?? '').map(rowRef => {
        const row = lookup(model, rowRef);
        const firstCell = row
          ? lookup(model, parseRefList(readProp(row.properties, PROP_CONTENT_REFS) ?? '')[0])
          : undefined;
        return {
          height: inches(row ? numberProp(row.properties, PROP_ROW_HEIGHT) : Number.NaN),
          firstCell: firstCell ? shapeText(model, firstCell) : '',
        };
      });
    }
    return layout;
  });
  return { slideIndex, slideWidth: 13.333, slideHeight: 7.5, units: 'inches', shapes };
};

export const readSlideLayoutAction: PodsReadActionSpec<{ slideIndex: number }> = {
  kind: 'read',
  classFilter: [...SHAPE_CLASSES, CLASS_TABLE, CLASS_TABLE_ROW],
  parseArgs: raw => {
    if (typeof raw.slideIndex !== 'number' || !Number.isInteger(raw.slideIndex) || raw.slideIndex < 1) {
      throw new FrameBridgeValidationError('read_slide_layout needs `slideIndex`: a 1-based slide position.');
    }
    return { slideIndex: raw.slideIndex };
  },
  read: (model, args) => readSlideLayout(model, args.slideIndex),
};

// ---------------------------------------------------------------------------
// move_shape

export interface MoveShapeArgs {
  slideIndex: number;
  shape: string;
  occurrence: number;
  /** New left edge, inches. */
  left?: number;
  /** New top edge, inches. */
  top?: number;
}

/** The client sequence hint the captured MoveShapes carried. Not server-validated. */
const MOVE_SEQUENCE = 38;

export const buildMoveShapeBody = (ctx: LocatedShape, args: MoveShapeArgs, mint: PodsMint): Record<string, unknown> => {
  const overrides = new Map<number, string>([[PROP_LAST_MODIFIED_TIME, mint.actionTime]]);
  if (args.left !== undefined) {
    overrides.set(PROP_LEFT, String(args.left * UNITS_PER_INCH));
    overrides.set(PROP_LEFT_MIRROR, String(args.left * UNITS_PER_INCH));
  }
  if (args.top !== undefined) {
    overrides.set(PROP_TOP, String(args.top * UNITS_PER_INCH));
    overrides.set(PROP_TOP_MIRROR, String(args.top * UNITS_PER_INCH));
  }
  return singleRevision(ctx.cellId, mint.guidToken, mint.headToken, MOVE_SEQUENCE, [
    descriptor(ctx.actionDescId, 'MoveShapes', 'MoveShapes', mint),
    {
      ObjectId: ctx.shape.objectId,
      ClassId: CLASS_RENDER_SHAPE,
      Properties: copyWith(ctx.shape.properties, overrides),
    },
  ]);
};

export const moveShapeAction: PodsWriteActionSpec<MoveShapeArgs, LocatedShape> = {
  kind: 'write',
  classFilter: SHAPE_CLASSES,
  parseArgs: raw => {
    const base = parseSlideShape(raw, 'move_shape');
    const left = optionalInches(raw.left, 'left', 'move_shape', true);
    const top = optionalInches(raw.top, 'top', 'move_shape', true);
    if (left === undefined && top === undefined) {
      throw new FrameBridgeValidationError('move_shape needs `left` and/or `top`, in inches.');
    }
    return { ...base, left, top };
  },
  resolve: (model, args) => locateShape(model, args.slideIndex, args.shape, args.occurrence),
  build: buildMoveShapeBody,
  isApplied: (model, first, args) => {
    const shape = model.objects.find(o => o.objectId === first.shape.objectId);
    if (!shape) return false;
    const near = (id: number, target: number | undefined) =>
      target === undefined ||
      Math.abs(numberProp(shape.properties, id) - target * UNITS_PER_INCH) <= GEOMETRY_TOLERANCE;
    return near(PROP_LEFT, args.left) && near(PROP_TOP, args.top);
  },
  // An absolute position: re-issuing it lands the shape in the same place.
  idempotent: true,
  summarize: (ctx, args) => ({
    slideIndex: ctx.slideIndex,
    shape: ctx.name,
    before: {
      left: inches(numberProp(ctx.shape.properties, PROP_LEFT)),
      top: inches(numberProp(ctx.shape.properties, PROP_TOP)),
    },
    after: { left: args.left ?? null, top: args.top ?? null },
  }),
};

// ---------------------------------------------------------------------------
// resize_shape

export interface ResizeShapeArgs {
  slideIndex: number;
  shape: string;
  occurrence: number;
  /** New width, inches. */
  width?: number;
  /** New height, inches. */
  height?: number;
}

/** The client sequence hint the captured ResizeShapes carried. Not server-validated. */
const RESIZE_SEQUENCE = 39;

export const buildResizeShapeBody = (
  ctx: LocatedShape,
  args: ResizeShapeArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  const toPixels = (current: number, target: number | undefined) =>
    target === undefined ? 0 : (target - current / UNITS_PER_INCH) * RESIZE_PIXELS_PER_INCH;
  const delta = {
    EastDelta: toPixels(numberProp(ctx.shape.properties, PROP_WIDTH), args.width),
    NorthDelta: 0,
    SouthDelta: toPixels(numberProp(ctx.shape.properties, PROP_HEIGHT), args.height),
    WestDelta: 0,
  };
  return singleRevision(ctx.cellId, mint.guidToken, mint.headToken, RESIZE_SEQUENCE, [
    descriptor(ctx.actionDescId, 'ResizeShapes', 'ResizeShapes', mint),
    {
      ObjectId: ctx.shape.objectId,
      ClassId: CLASS_RENDER_SHAPE,
      Properties: copyWith(
        ctx.shape.properties,
        new Map([
          [PROP_LAST_MODIFIED_TIME, mint.actionTime],
          [PROP_RESIZE_DELTA, JSON.stringify(delta)],
        ]),
      ),
    },
  ]);
};

export const resizeShapeAction: PodsWriteActionSpec<ResizeShapeArgs, LocatedShape> = {
  kind: 'write',
  classFilter: [...SHAPE_CLASSES, CLASS_TABLE],
  parseArgs: raw => {
    const base = parseSlideShape(raw, 'resize_shape');
    const width = optionalInches(raw.width, 'width', 'resize_shape', false);
    const height = optionalInches(raw.height, 'height', 'resize_shape', false);
    if (width === undefined && height === undefined) {
      throw new FrameBridgeValidationError('resize_shape needs `width` and/or `height`, in inches.');
    }
    return { ...base, width, height };
  },
  resolve: (model, args) => {
    const ctx = locateShape(model, args.slideIndex, args.shape, args.occurrence);
    if (tableOf(model, ctx.shape, ctx.slide)) {
      throw new FrameBridgeValidationError(
        `"${args.shape}" is a table. Set its height with set_table_height; its rows size to their text.`,
      );
    }
    return ctx;
  },
  build: buildResizeShapeBody,
  isApplied: (model, first, args) => {
    const shape = model.objects.find(o => o.objectId === first.shape.objectId);
    if (!shape) return false;
    const near = (id: number, target: number | undefined) =>
      target === undefined ||
      Math.abs(numberProp(shape.properties, id) - target * UNITS_PER_INCH) <= GEOMETRY_TOLERANCE;
    return near(PROP_WIDTH, args.width) && near(PROP_HEIGHT, args.height);
  },
  // A delta: re-issuing an applied resize would grow the shape a second time.
  idempotent: false,
  summarize: (ctx, args) => ({
    slideIndex: ctx.slideIndex,
    shape: ctx.name,
    before: {
      width: inches(numberProp(ctx.shape.properties, PROP_WIDTH)),
      height: inches(numberProp(ctx.shape.properties, PROP_HEIGHT)),
    },
    after: { width: args.width ?? null, height: args.height ?? null },
  }),
};

// ---------------------------------------------------------------------------
// duplicate_shape

export interface DuplicateShapeArgs {
  slideIndex: number;
  shape: string;
  occurrence: number;
  /** The copy's left edge, inches; the source's when omitted. */
  left?: number;
  /** The copy's top edge, inches; the source's when omitted. */
  top?: number;
}

export interface DuplicateShapeContext extends LocatedShape {
  /** The source's text bodies, each with its paragraphs. */
  bodies: Array<{ body: PodsObject; paragraphs: PodsObject[] }>;
  levelStyles: PodsObject[];
  /** The slide's shape references before the copy. */
  shapeRefs: string[];
}

/** The client sequence hint the captured DuplicateShape carried. Not server-validated. */
const DUPLICATE_SEQUENCE = 37;
const SLOT_COPY = 1;
const FIRST_BODY_SLOT = 10;
const FIRST_PARAGRAPH_SLOT = 20;
const FIRST_STYLE_SLOT = 60;

export const resolveDuplicateShapeContext = (model: PodsModel, args: DuplicateShapeArgs): DuplicateShapeContext => {
  const located = locateShape(model, args.slideIndex, args.shape, args.occurrence);
  if (tableOf(model, located.shape, located.slide)) {
    throw new FrameBridgeValidationError(`"${args.shape}" is a table; duplicating tables is not supported.`);
  }
  const bodies = parseRefList(readProp(located.shape.properties, PROP_CONTENT_REFS) ?? '')
    .map(ref => lookup(model, ref))
    .filter((o): o is PodsObject => o?.classId === CLASS_TEXT_BODY)
    .map(body => ({
      body,
      paragraphs: parseRefList(readProp(body.properties, PROP_ORDERED_CHILDREN) ?? '')
        .map(ref => lookup(model, ref))
        .filter((o): o is PodsObject => o?.classId === CLASS_PARAGRAPH),
    }));
  const levelStyles = parseRefList(readProp(located.shape.properties, PROP_LEVEL_STYLES) ?? '')
    .map(ref => lookup(model, ref))
    .filter((o): o is PodsObject => o?.classId === CLASS_LEVEL_STYLE);
  return {
    ...located,
    bodies,
    levelStyles,
    shapeRefs: parseRefList(readProp(located.slide.properties, PROP_CONTENT_REFS) ?? ''),
  };
};

/** Derive a stable `{UPPERCASE-GUID}` and a plain guid for owners from the call's seed. */
const seededGuids = (seed: string, count: number): { creation: string; owners: string[] } => {
  const hex = seed.replace(/-/g, '');
  const guid = (salt: number) =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${String(salt).padStart(4, '0')}-${hex.slice(20, 32)}`;
  return { creation: `{${guid(9999).toUpperCase()}}`, owners: Array.from({ length: count }, (_, i) => guid(i)) };
};

export const buildDuplicateShapeBody = (
  ctx: DuplicateShapeContext,
  args: DuplicateShapeArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  const g = mint.guidToken;
  const copyId = `${g}|${SLOT_COPY}`;
  const copyRef = `{${g}}{${SLOT_COPY}}`;
  const guids = seededGuids(mint.seed, ctx.bodies.length);

  let paragraphSlot = FIRST_PARAGRAPH_SLOT;
  const bodyObjects: Array<Record<string, unknown>> = [];
  const bodyRefs: string[] = [];
  ctx.bodies.forEach(({ body, paragraphs }, i) => {
    const bodySlot = FIRST_BODY_SLOT + i;
    const owner = guids.owners[i] as string;
    const paragraphRefs: string[] = [];
    const paragraphObjects = paragraphs.map(paragraph => {
      const slot = paragraphSlot++;
      paragraphRefs.push(`{${g}}{${slot}}`);
      return {
        ObjectId: `${g}|${slot}`,
        ClassId: CLASS_PARAGRAPH,
        Properties: copyWith(
          paragraph.properties,
          new Map([
            [PROP_BLOCK_OWNER, owner],
            [PROP_SLIDE_BACKREF, ctx.slideRef],
            [PROP_OWNER_BACKREF, copyRef],
          ]),
        ),
      };
    });
    bodyRefs.push(`{${g}}{${bodySlot}}`);
    bodyObjects.push(
      {
        ObjectId: `${g}|${bodySlot}`,
        ClassId: CLASS_TEXT_BODY,
        Properties: copyWith(
          body.properties,
          new Map([
            [PROP_BLOCK_OWNER, owner],
            [PROP_SLIDE_BACKREF, ctx.slideRef],
            [PROP_OWNER_BACKREF, copyRef],
            [PROP_ORDERED_CHILDREN, paragraphRefs.join(',')],
          ]),
        ),
      },
      ...paragraphObjects,
    );
  });

  const styleObjects = ctx.levelStyles.map((style, i) => ({
    ObjectId: `${g}|${FIRST_STYLE_SLOT + i}`,
    ClassId: CLASS_LEVEL_STYLE,
    Properties: sortPropertiesById([...style.properties]),
  }));

  const sourceRef = ctx.shapeRefs.find(ref => refToObjectId(ref) === ctx.shape.objectId) as string;
  const copyOverrides = new Map<number, string>([
    [PROP_SHAPE_ID, '0'],
    [PROP_CREATION_GUID, guids.creation],
    [PROP_LAST_MODIFIED_TIME, mint.actionTime],
    [PROP_SLIDE_BACKREF, ctx.slideRef],
    [PROP_OWNER_BACKREF, sourceRef],
    [PROP_CONTENT_REFS, bodyRefs.join(',')],
    [PROP_LEVEL_STYLES, styleObjects.map((_, i) => `{${g}}{${FIRST_STYLE_SLOT + i}}`).join(',')],
  ]);
  if (args.left !== undefined) {
    copyOverrides.set(PROP_LEFT, String(args.left * UNITS_PER_INCH));
    copyOverrides.set(PROP_LEFT_MIRROR, String(args.left * UNITS_PER_INCH));
  }
  if (args.top !== undefined) {
    copyOverrides.set(PROP_TOP, String(args.top * UNITS_PER_INCH));
    copyOverrides.set(PROP_TOP_MIRROR, String(args.top * UNITS_PER_INCH));
  }
  const sourceWithoutStamp = ctx.shape.properties.filter(
    (_, i, all) => !(i % 2 === 0 && all[i] === PROP_AUTHOR_STAMP) && !(i % 2 === 1 && all[i - 1] === PROP_AUTHOR_STAMP),
  );

  return singleRevision(ctx.cellId, g, mint.headToken, DUPLICATE_SEQUENCE, [
    // The editor's own duplicate leaves the action label empty and names it only in the descriptor json.
    descriptor(ctx.actionDescId, 'DuplicateShape', '', mint),
    {
      ObjectId: ctx.slide.objectId,
      ClassId: CLASS_SLIDE,
      Properties: copyWith(ctx.slide.properties, new Map([[PROP_CONTENT_REFS, [...ctx.shapeRefs, copyRef].join(',')]])),
    },
    { ObjectId: copyId, ClassId: CLASS_RENDER_SHAPE, Properties: copyWith(sourceWithoutStamp, copyOverrides) },
    ...bodyObjects,
    ...styleObjects,
  ]);
};

export const duplicateShapeAction: PodsWriteActionSpec<DuplicateShapeArgs, DuplicateShapeContext> = {
  kind: 'write',
  classFilter: [...SHAPE_CLASSES, CLASS_TABLE],
  parseArgs: raw => {
    const base = parseSlideShape(raw, 'duplicate_shape');
    return {
      ...base,
      left: optionalInches(raw.left, 'left', 'duplicate_shape', true),
      top: optionalInches(raw.top, 'top', 'duplicate_shape', true),
    };
  },
  resolve: resolveDuplicateShapeContext,
  build: buildDuplicateShapeBody,
  /**
   * Applied when the slide lists a shape it did not, carrying the source's name at the
   * requested position. The copy keeps the source's name: a name written with the copy
   * is accepted and then dropped when the server saves, so none is offered.
   */
  isApplied: (model, first, args) => {
    const slide = model.objects.find(o => o.objectId === first.slide.objectId);
    if (!slide) return false;
    const known = new Set(first.shapeRefs);
    const wantName = first.name;
    return parseRefList(readProp(slide.properties, PROP_CONTENT_REFS) ?? '')
      .filter(ref => !known.has(ref))
      .map(ref => lookup(model, ref))
      .some(
        shape =>
          shape !== undefined &&
          readProp(shape.properties, PROP_SHAPE_NAME) === wantName &&
          (args.left === undefined ||
            Math.abs(numberProp(shape.properties, PROP_LEFT) - args.left * UNITS_PER_INCH) <= GEOMETRY_TOLERANCE) &&
          (args.top === undefined ||
            Math.abs(numberProp(shape.properties, PROP_TOP) - args.top * UNITS_PER_INCH) <= GEOMETRY_TOLERANCE),
      );
  },
  // A copy is not idempotent — a repeat adds a second copy.
  idempotent: false,
  summarize: (ctx, args) => ({
    slideIndex: ctx.slideIndex,
    shape: ctx.name,
    left: args.left ?? inches(numberProp(ctx.shape.properties, PROP_LEFT)),
    top: args.top ?? inches(numberProp(ctx.shape.properties, PROP_TOP)),
  }),
};

// ---------------------------------------------------------------------------
// set_table_height

export interface SetTableHeightArgs {
  /** The 1-based slide holding the table. */
  slideIndex: number;
  /** Exact visible text of any cell in the table. */
  table: string;
  /** The table's new height, inches. */
  height: number;
}

export interface TableHeightContext {
  cellId: string;
  actionDescId: string;
  table: PodsObject;
  rows: PodsObject[];
}

/** The client sequence hint the captured SetTableHeight carried. Not server-validated. */
const TABLE_HEIGHT_SEQUENCE = 41;

const tableHeightUnits = (rows: PodsObject[]): number =>
  rows.reduce((sum, row) => sum + numberProp(row.properties, PROP_ROW_HEIGHT), 0);

export const resolveTableHeightContext = (model: PodsModel, slideIndex: number, text: string): TableHeightContext => {
  const { cellId, actionDescId, table, rowRefs } = locateTableRow(model, text, findSlideAt(model, slideIndex).slide);
  const rows = rowRefs.map(ref => lookup(model, ref)).filter((o): o is PodsObject => o?.classId === CLASS_TABLE_ROW);
  if (rows.length === 0 || !Number.isFinite(tableHeightUnits(rows))) {
    throw new FrameBridgeValidationError('The table has no rows with a readable height.');
  }
  return { cellId, actionDescId, table, rows };
};

/** Scale every row by the same factor, as the editor's own SetTableHeight does. */
export const buildSetTableHeightBody = (
  ctx: TableHeightContext,
  args: SetTableHeightArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  const factor = (args.height * UNITS_PER_INCH) / tableHeightUnits(ctx.rows);
  return singleRevision(ctx.cellId, mint.guidToken, mint.headToken, TABLE_HEIGHT_SEQUENCE, [
    descriptor(ctx.actionDescId, 'SetTableHeight', 'SetTableHeight', mint),
    ...ctx.rows.map(row => ({
      ObjectId: row.objectId,
      ClassId: CLASS_TABLE_ROW,
      Properties: copyWith(
        row.properties,
        new Map([
          [PROP_ROW_HEIGHT, String(numberProp(row.properties, PROP_ROW_HEIGHT) * factor)],
          [PROP_LAST_MODIFIED_TIME, mint.actionTime],
        ]),
      ),
    })),
  ]);
};

export const setTableHeightAction: PodsWriteActionSpec<SetTableHeightArgs, TableHeightContext> = {
  kind: 'write',
  classFilter: [...TEXT_BLOCK_CLASSES, CLASS_SLIDE],
  parseArgs: raw => {
    if (typeof raw.slideIndex !== 'number' || !Number.isInteger(raw.slideIndex) || raw.slideIndex < 1) {
      throw new FrameBridgeValidationError('set_table_height needs `slideIndex`: the 1-based slide holding the table.');
    }
    if (typeof raw.table !== 'string' || raw.table.length === 0) {
      throw new FrameBridgeValidationError('set_table_height needs `table`: the exact visible text of a cell in it.');
    }
    const height = optionalInches(raw.height, 'height', 'set_table_height', false);
    if (height === undefined) throw new FrameBridgeValidationError('set_table_height needs `height`, in inches.');
    return { slideIndex: raw.slideIndex, table: raw.table, height };
  },
  resolve: (model, args) => resolveTableHeightContext(model, args.slideIndex, args.table),
  build: buildSetTableHeightBody,
  isApplied: (model, first, args) => {
    const rows = first.rows.map(row => model.objects.find(o => o.objectId === row.objectId));
    if (rows.some(row => row === undefined)) return false;
    return (
      Math.abs(tableHeightUnits(rows as PodsObject[]) - args.height * UNITS_PER_INCH) <=
      GEOMETRY_TOLERANCE * rows.length
    );
  },
  // An absolute height: re-issuing it rescales to the same total.
  idempotent: true,
  summarize: (ctx, args) => ({
    table: args.table,
    rows: ctx.rows.length,
    heightBefore: inches(tableHeightUnits(ctx.rows)),
    height: args.height,
  }),
};

// ---------------------------------------------------------------------------
// set_shape_fill

export interface SetShapeFillArgs {
  slideIndex: number;
  shape: string;
  occurrence: number;
  /** The solid fill colour, RRGGBB. */
  colorHex: string;
}

/** The colour-picker record the editor writes alongside a chosen fill colour. */
const PROP_FILL_PICKER = 469780594;
/** The shape style's fill colour, cleared when an explicit fill is chosen. */
const PROP_STYLE_FILL = 469780771;
/** The client sequence hint the captured ApplyShapeFillColor carried. Not server-validated. */
const FILL_SEQUENCE = 18;

/**
 * Build the `ApplyShapeFillColor` body: two chained revisions, as the editor sends
 * when a Shape Fill swatch is picked. The first sets the fill and clears the style
 * colour; the second, based on the first, repeats that and adds the picker record.
 */
export const buildSetShapeFillBody = (
  ctx: LocatedShape,
  args: SetShapeFillArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  const hex = args.colorHex.toUpperCase();
  const rgb = [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
  const filled = new Map<number, string>([
    [PROP_FILL, JSON.stringify({ solidFillField: { srgbClrField: { valField: rgb } } })],
    [PROP_STYLE_FILL, ''],
    [PROP_LAST_MODIFIED_TIME, mint.actionTime],
  ]);
  const withPicker = new Map(filled);
  withPicker.set(
    PROP_FILL_PICKER,
    JSON.stringify({ Alpha: 100, ColorLuminance: 0, FTintColor: false, RGBColor: hex, ThemeColor: -1 }),
  );
  const revision = (
    slot: number,
    groupSlot: number,
    baseId: string,
    label: string,
    overrides: Map<number, string>,
  ) => ({
    Id: `${mint.guidToken}|${slot}`,
    FileId: null,
    RelativePath: null,
    CellId: ctx.cellId,
    ContextId: '00000000-0000-0000-0000-000000000000|0',
    ExpectedLatestId: '00000000-0000-0000-0000-000000000000|0',
    BaseId: baseId,
    RootObjectDescriptors: null,
    ObjectGroups: [
      {
        Id: `${mint.guidToken}|${groupSlot}`,
        Objects: [
          descriptor(ctx.actionDescId, 'ApplyShapeFillColor', label, mint),
          {
            ObjectId: ctx.shape.objectId,
            ClassId: CLASS_RENDER_SHAPE,
            Properties: copyWith(ctx.shape.properties, overrides),
          },
        ],
      },
    ],
    IsFolderCell: false,
  });
  return {
    Mode: 4,
    srs: [
      [
        3,
        {
          OperationId: 1,
          DependentOn: 0,
          Revisions: [
            revision(2, 3, mint.headToken, '', filled),
            revision(4, 5, `${mint.guidToken}|2`, 'ApplyShapeFillColor', withPicker),
          ],
          ExpectedLatestId: mint.headToken,
          Sequence: FILL_SEQUENCE,
          PutOnlyCall: false,
          LocalRenderingParams: null,
        },
      ],
    ],
  };
};

export const setShapeFillAction: PodsWriteActionSpec<SetShapeFillArgs, LocatedShape> = {
  kind: 'write',
  classFilter: SHAPE_CLASSES,
  parseArgs: raw => {
    const base = parseSlideShape(raw, 'set_shape_fill');
    if (typeof raw.colorHex !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(raw.colorHex)) {
      throw new FrameBridgeValidationError('set_shape_fill needs `colorHex`: a six-digit RRGGBB colour.');
    }
    return { ...base, colorHex: raw.colorHex.replace('#', '').toUpperCase() };
  },
  resolve: (model, args) => locateShape(model, args.slideIndex, args.shape, args.occurrence),
  build: buildSetShapeFillBody,
  isApplied: (model, first, args) => {
    const shape = model.objects.find(o => o.objectId === first.shape.objectId);
    return shape !== undefined && fillHexOf(shape) === args.colorHex;
  },
  // An absolute colour: re-issuing it leaves the same fill.
  idempotent: true,
  summarize: (ctx, args) => ({
    slideIndex: ctx.slideIndex,
    shape: ctx.name,
    fillBefore: fillHexOf(ctx.shape),
    fill: args.colorHex,
  }),
};
