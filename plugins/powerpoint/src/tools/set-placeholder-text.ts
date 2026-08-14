import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  appendPlaceholder,
  findSlot,
  readLayoutSlots,
  resolveSlots,
  resolveSlotFontSize,
  SLOT_ROLES,
} from '../placeholders.js';
import {
  editPresentation,
  getRelatedParts,
  readSlideXml,
  requireSlideFile,
  TEXT_DECODER,
  writeSlideXml,
} from '../pptx-utils.js';
import { editShapeText, findSpTree, getMaxCNvPrId, parseOutline } from '../slide-edit.js';
import { getSlideSize, parseSlideLayout, resolveInheritedGeometry } from '../slide-layout.js';
import { fitFontSize } from '../text-metrics.js';
import { parseXml, serializeXml } from '../xml.js';
import { driveIdInput } from './schemas.js';

/** Bullet hanging indent in inches, narrowing the usable width of body text. */
const BULLET_INDENT_IN = 0.3;
/** Gap between paragraphs as a multiple of font size, matching stock body styling. */
const BODY_PARAGRAPH_SPACING = 0.3;
/** Floor for shrink-to-fit. Below this, text is unreadable from the back of a room. */
const MIN_FIT_FONT_PT = 10;
/** Ceiling used only when the deck states no default size anywhere in the cascade. */
const FALLBACK_FONT_PT = 18;

export const setPlaceholderText = defineTool({
  name: 'set_placeholder_text',
  displayName: 'Set Placeholder Text',
  description:
    'Write text into a slide slot by naming it — "title", "subtitle", or "body" — with no need to look up a shape ' +
    'id first. Reach for this when filling in a slide; use `update_shape` only for shapes that are not ' +
    'placeholders. If the layout defines the slot but the slide has no shape for it yet, the placeholder is ' +
    'created, inheriting position, size, and formatting from the layout exactly as PowerPoint does. Text that would ' +
    'overflow its box is shrunk to the largest size that fits and the size is reported; text that already fits ' +
    "keeps the size it inherits, so the deck's design is left alone.",
  summary: 'Write text into a slide slot by role (title, body)',
  icon: 'type',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    role: z.enum(SLOT_ROLES).describe('Which slot to write: title, subtitle, or body'),
    text: z
      .string()
      .describe(
        'Text to write. Use \\n to separate paragraphs. Prefix a paragraph with tab characters to demote it to a ' +
          'deeper bullet level — one tab for the second level, two for the third, up to eight. Indents, bullet ' +
          'glyphs, and per-level sizes come from the layout, exactly as when a person presses Tab.',
      ),
    idx: z
      .number()
      .int()
      .optional()
      .describe('Placeholder index, to pick between same-role slots. Get it from `get_slide_structure`.'),
    fit: z
      .enum(['shrink', 'none'])
      .optional()
      .describe(
        'How to handle text that does not fit. "shrink" (default) reduces the font size until it does; ' +
          '"none" leaves the inherited size and lets the text overflow.',
      ),
  }),
  output: z.object({
    shape_id: z.string().describe('Shape serving the slot — newly created if the slide had none'),
    created: z.boolean().describe('True when the placeholder did not exist on the slide and was created'),
    font_size: z
      .number()
      .nullable()
      .describe('Size applied in points, or null when the text fit and the inherited size was left in place'),
    fits: z.boolean().describe('False when the text overflows the box even at the smallest size considered'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      const layoutPart = getRelatedParts(entries, file, '/slideLayout')[0];
      const layoutData = layoutPart ? entries.get(layoutPart) : undefined;
      const layoutSlots = layoutData ? readLayoutSlots(TEXT_DECODER.decode(layoutData)) : [];

      const inheritedGeometry = resolveInheritedGeometry(entries, file);
      let slideXml = readSlideXml(entries, file);
      const slots = resolveSlots(
        parseSlideLayout(slideXml, params.slide_number, getSlideSize(entries), inheritedGeometry).shapes,
        layoutSlots,
      );
      const slot = findSlot(slots, params.role, params.idx);

      // A slot the layout offers but the slide never filled has no shape yet.
      // Creating it — rather than refusing — is what makes a role-based API work
      // on any slide, including one whose placeholder was deleted.
      let created = false;
      let shapeId = slot.shape_id;
      if (shapeId === null) {
        const spec = layoutSlots.find(s => s.idx === slot.idx);
        if (!spec) throw ToolError.internal(`Slot idx ${slot.idx} is not defined by the layout`);
        const doc = parseXml(slideXml);
        const spTree = findSpTree(doc);
        if (!spTree) throw ToolError.internal('Slide has no spTree');
        const newId = getMaxCNvPrId(doc) + 1;
        appendPlaceholder(spTree, spec, newId, slots.filter(s => s.role === slot.role).length);
        slideXml = serializeXml(doc);
        shapeId = String(newId);
        created = true;
      }

      // A placeholder states no geometry of its own, so its box comes from the
      // layout — which is also where a freshly created slot gets one.
      const box = slot.shape_id === null ? inheritedGeometry.get(slot.idx) : slot;

      let fontSize: number | null = null;
      let fits = true;
      if (params.fit !== 'none' && box && box.w > 0 && box.h > 0) {
        const inheritedPt = resolveSlotFontSize(entries, file, slot.role, slot.idx) ?? FALLBACK_FONT_PT;
        const bulleted = slot.role === 'body';
        // A demoted paragraph starts further in, so the deepest level sets the
        // narrowest line in the block. Measuring against that over-estimates the
        // height of the shallower ones, which is the safe direction to err:
        // slightly small text is fixable by eye, text off the slide is not.
        const deepestLevel = Math.max(...parseOutline(params.text).map(p => p.level));
        const result = fitFontSize(params.text, box.w, box.h, inheritedPt, MIN_FIT_FONT_PT, {
          font: slot.font,
          indentIn: bulleted ? BULLET_INDENT_IN * (1 + deepestLevel) : 0,
          paragraphSpacing: bulleted ? BODY_PARAGRAPH_SPACING : 0,
        });
        fits = result.fits;
        // Restating the inherited size would pin the slot against later theme or
        // layout changes for no gain, so only an actual reduction is written.
        if (result.fontSizePt < inheritedPt) fontSize = result.fontSizePt;
      }

      writeSlideXml(
        entries,
        file,
        editShapeText(slideXml, shapeId, params.text, fontSize === null ? undefined : { fontSize }),
      );

      return { shape_id: shapeId, created, font_size: fontSize, fits };
    }),
});
