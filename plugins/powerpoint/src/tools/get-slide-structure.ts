import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { readLayoutSlots, resolveSlots, shapeText } from '../placeholders.js';
import { downloadPptx, getRelatedParts, readSlideXml, requireSlideFile, TEXT_DECODER } from '../pptx-utils.js';
import { isSlideHidden } from '../slide-edit.js';
import { getSlideSize, parseSlideLayout, resolveInheritedGeometry } from '../slide-layout.js';
import { childByLocalName, parseXml } from '../xml.js';
import { driveIdInput, slideSlotSchema } from './schemas.js';

/** The layout's author-facing name, e.g. "Title and Content". */
const readLayoutName = (layoutXml: string): string | null => {
  const root = parseXml(layoutXml).documentElement;
  const cSld = root ? childByLocalName(root, 'cSld') : undefined;
  return cSld?.getAttribute('name') || root?.getAttribute('type') || null;
};

/** Layout slot indexes, so a slide can report which of its layout's slots it left unused. */
const layoutSlotsOf = (entries: Map<string, Uint8Array>, layoutPart: string | undefined) => {
  const data = layoutPart ? entries.get(layoutPart) : undefined;
  return data ? readLayoutSlots(TEXT_DECODER.decode(data)) : [];
};

export const getSlideStructure = defineTool({
  name: 'get_slide_structure',
  displayName: 'Get Slide Structure',
  description:
    'Return a slide as the named slots it offers — title, subtitle, body — rather than as shapes at coordinates. ' +
    'Use this before writing text so you can address a slot by role with `set_placeholder_text` instead of hunting ' +
    'for a shape id. Slots the layout defines but the slide has not filled are included with a null `shape_id`; ' +
    'writing to one creates it. Anything that is not a placeholder (added text boxes, shapes, pictures) is listed ' +
    'separately under `other_shapes`. Positions are in inches and resolve through the layout and master, so a ' +
    'placeholder that states no geometry of its own still reports its real box.',
  summary: 'Get a slide as named slots (title, body) rather than shapes',
  icon: 'layout-template',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number to inspect (1-indexed)'),
  }),
  output: z.object({
    slide_number: z.number().int().describe('Slide number (1-indexed)'),
    hidden: z
      .boolean()
      .describe("True when the slide is hidden from the slide show — deliberately outside the deck's narrative"),
    layout_name: z.string().nullable().describe('Name of the layout this slide uses, e.g. "Title and Content"'),
    layout_part: z.string().nullable().describe('Package path of the layout, for passing to `add_slide`'),
    width: z.number().describe('Slide canvas width in inches'),
    height: z.number().describe('Slide canvas height in inches'),
    slots: z.array(slideSlotSchema).describe('Named slots, ordered by placeholder index'),
    other_shapes: z
      .array(
        z.object({
          id: z.string().describe('Shape id for `update_shape`'),
          name: z.string(),
          kind: z.string().describe('textbox, shape, picture, table, chart, group, connector'),
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          text: z.string().describe('Text content, paragraphs joined by newline'),
        }),
      )
      .describe('Shapes on the slide that are not placeholders'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id, params.drive_id);
    const file = requireSlideFile(entries, params.slide_number);
    const layoutPart = getRelatedParts(entries, file, '/slideLayout')[0];
    const layoutData = layoutPart ? entries.get(layoutPart) : undefined;

    const canvas = getSlideSize(entries);
    const slideXml = readSlideXml(entries, file);
    const layout = parseSlideLayout(slideXml, params.slide_number, canvas, resolveInheritedGeometry(entries, file));
    const slots = resolveSlots(layout.shapes, layoutSlotsOf(entries, layoutPart));
    const slotShapeIds = new Set(slots.map(s => s.shape_id).filter((id): id is string => id !== null));

    return {
      slide_number: params.slide_number,
      hidden: isSlideHidden(slideXml),
      layout_name: layoutData ? readLayoutName(TEXT_DECODER.decode(layoutData)) : null,
      layout_part: layoutPart ?? null,
      width: canvas.width,
      height: canvas.height,
      slots,
      other_shapes: layout.shapes
        .filter(s => !slotShapeIds.has(s.id))
        .map(s => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          x: s.x,
          y: s.y,
          w: s.w,
          h: s.h,
          text: shapeText(s),
        })),
    };
  },
});
