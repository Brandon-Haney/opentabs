/**
 * Pods `read_outline` action — the LIVE view of an open deck.
 *
 * The OOXML read tools report the last *saved* package, which trails the live
 * document during active co-editing. This read reduces the same live model every
 * pods write resolves against — slide list, paragraphs with their run formatting,
 * shape names — so a reviewer (or a post-write verification) sees the deck as it
 * is on screen right now.
 *
 * The reduction is capped and carries honesty counts, so a partial view is never
 * mistaken for the whole deck.
 */

import type { PodsReadActionSpec } from './pods-actions.js';
import {
  CLASS_PARAGRAPH,
  CLASS_RENDER_SHAPE,
  CLASS_RUN,
  CLASS_SLIDE,
  findPresentationRoot,
  type PodsModel,
  PROP_RUN_REF,
  PROP_SHAPE_NAME,
  PROP_TEXT,
  parseRefList,
  readProp,
  refToObjectId,
  slideRefsOf,
} from './pods-model.js';

/** Run (1179725) format property ids, mirrored from the run-format action's decode. */
const PROP_FONT_SIZE = 268442635;
const PROP_BOLD = 134224900;
const PROP_ITALIC = 134224901;
const PROP_UNDERLINE = 134224902;
const PROP_COLOR_STR = 469780760;
const PROP_FONT_LATIN = 469780527;

/** Paragraphs returned before capping. Generous for a deck; honest when exceeded. */
const MAX_PARAGRAPHS = 300;
/** Shape names returned before capping. */
const MAX_SHAPES = 200;

/** One run's formatting, in agent-facing units. */
interface OutlineRun {
  sizePt: number | null;
  bold: boolean | null;
  italic: boolean | null;
  underline: boolean | null;
  colorHex: string | null;
  font: string | null;
}

/** One paragraph of live text and the formatting of its runs. */
interface OutlineParagraph {
  text: string;
  runs: OutlineRun[];
}

const flagToBool = (value: string | undefined): boolean | null => (value === undefined ? null : value === 'true');

/** `@RRGGBB,…` display colour → the 6-digit hex, or null when absent/unparseable. */
const colorToHex = (value: string | undefined): string | null => {
  const m = value?.match(/^@([0-9a-fA-F]{6})/);
  return m ? (m[1] as string).toUpperCase() : null;
};

const runFormatting = (properties: (string | number)[]): OutlineRun => {
  const sizeHalfPt = readProp(properties, PROP_FONT_SIZE);
  return {
    sizePt: sizeHalfPt === undefined ? null : Number(sizeHalfPt) / 2,
    bold: flagToBool(readProp(properties, PROP_BOLD)),
    italic: flagToBool(readProp(properties, PROP_ITALIC)),
    underline: flagToBool(readProp(properties, PROP_UNDERLINE)),
    colorHex: colorToHex(readProp(properties, PROP_COLOR_STR)),
    font: readProp(properties, PROP_FONT_LATIN) ?? null,
  };
};

/** Reduce the live model to the outline. Exported for unit tests over fixture models. */
export const reduceOutline = (model: PodsModel): Record<string, unknown> => {
  const root = findPresentationRoot(model);
  const { slideRefs } = slideRefsOf(root);
  const byId = new Map(model.objects.map(o => [o.objectId, o]));

  const allParagraphs: OutlineParagraph[] = [];
  for (const o of model.objects) {
    if (o.classId !== CLASS_PARAGRAPH) continue;
    const text = readProp(o.properties, PROP_TEXT);
    if (text === undefined) continue;
    const runs: OutlineRun[] = [];
    for (const token of parseRefList(readProp(o.properties, PROP_RUN_REF) ?? '')) {
      const id = refToObjectId(token);
      const run = id ? byId.get(id) : undefined;
      if (run && run.classId === CLASS_RUN) runs.push(runFormatting(run.properties));
    }
    allParagraphs.push({ text, runs });
  }

  const allShapes = model.objects
    .filter(o => o.classId === CLASS_RENDER_SHAPE)
    .map(o => readProp(o.properties, PROP_SHAPE_NAME))
    .filter((name): name is string => Boolean(name));

  return {
    slideCount: slideRefs.length,
    slideRefs,
    paragraphs: allParagraphs.slice(0, MAX_PARAGRAPHS),
    paragraphTotal: allParagraphs.length,
    shapes: allShapes.slice(0, MAX_SHAPES),
    shapeTotal: allShapes.length,
    totalObjects: model.totalObjects,
  };
};

/** The `read_outline` action: the live deck reduced to text, formatting, and structure. */
export const readOutlineAction: PodsReadActionSpec<Record<string, never>> = {
  kind: 'read',
  classFilter: [CLASS_SLIDE, CLASS_PARAGRAPH, CLASS_RUN, CLASS_RENDER_SHAPE],
  parseArgs: () => ({}),
  read: model => reduceOutline(model),
};
