import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editPresentation, readSlideXml, requireSlideFile, writeSlideXml } from '../pptx-utils.js';
import { editShapeText, formatShapeText } from '../slide-edit.js';
import { getSlideSize, parseSlideLayout, resolveInheritedGeometry } from '../slide-layout.js';
import { fitFontSize } from '../text-metrics.js';
import { driveIdInput } from './schemas.js';

export const fitText = defineTool({
  name: 'fit_text',
  displayName: 'Fit Text To Shape',
  description:
    'Write text into a shape at the largest font size that still fits its box, so the text cannot overflow the ' +
    'slide. Measures the shape (including geometry inherited from the slide layout), estimates the wrapped height, ' +
    'and applies the best whole-point size. Omit `text` to re-fit the text already in the shape — the usual fix ' +
    'after resizing a box or adding bullets. Returns the size chosen and whether it fit: when `fits` is false the ' +
    'text is too long for the box even at `min_font_size`, and it needs shortening or a larger shape. ' +
    'Prefer this over `update_shape` whenever the amount of text is not known to be small.',
  summary: 'Write text at the largest size that fits the shape',
  icon: 'text-cursor-input',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    shape_id: z.string().describe('Shape id from get_slide_layout'),
    text: z
      .string()
      .optional()
      .describe('New text content. Use \\n for line breaks. Omit to re-fit the text already in the shape.'),
    max_font_size: z.number().positive().optional().describe('Largest size to consider, in points (default 28)'),
    min_font_size: z.number().positive().optional().describe('Smallest acceptable size, in points (default 10)'),
    bulleted: z
      .boolean()
      .optional()
      .describe('Account for a bullet hanging indent, narrowing the usable width. Defaults to true for body text.'),
  }),
  output: z.object({
    font_size: z.number().describe('Font size applied, in points'),
    estimated_height: z.number().describe('Estimated height of the text at that size, in inches'),
    box_height: z.number().describe('Height of the shape, in inches'),
    fits: z.boolean().describe('False when the text overflows even at min_font_size — shorten it or enlarge the shape'),
  }),
  handle: async params =>
    editPresentation(params.item_id, params.drive_id, entries => {
      const file = requireSlideFile(entries, params.slide_number);
      const slideXmlIn = readSlideXml(entries, file);

      // Resolve the shape through the same inheritance chain `get_slide_layout`
      // uses, so a placeholder that states no geometry still reports a real box.
      const layout = parseSlideLayout(
        slideXmlIn,
        params.slide_number,
        getSlideSize(entries),
        resolveInheritedGeometry(entries, file),
      );
      const shape = layout.shapes.find(s => s.id === params.shape_id);
      if (!shape) throw ToolError.notFound(`Shape ${params.shape_id} not found on slide ${params.slide_number}`);
      if (shape.w <= 0 || shape.h <= 0) {
        throw ToolError.validation(
          `Shape ${params.shape_id} has no resolvable size (${shape.w}x${shape.h} in), so text cannot be fitted to it`,
        );
      }

      const text = params.text ?? (shape.text ?? []).map(p => p.runs.map(r => r.text).join('')).join('\n');
      if (!text) throw ToolError.validation(`Shape ${params.shape_id} has no text and none was supplied`);

      // A bulleted paragraph hangs its wrapped lines past the bullet, so the
      // usable width is narrower than the box. Body placeholders are bulleted by
      // default in every stock layout.
      const bulleted = params.bulleted ?? shape.placeholder_type === 'body';
      const result = fitFontSize(text, shape.w, shape.h, params.max_font_size ?? 28, params.min_font_size ?? 10, {
        // Measured against the face the text actually states, when it states
        // one; unfonted text inherits from the theme and takes the default.
        font: shape.text?.[0]?.runs?.[0]?.font,
        indentIn: bulleted ? 0.3 : 0,
        paragraphSpacing: 0.3,
      });

      const format = { fontSize: result.fontSizePt };
      writeSlideXml(
        entries,
        file,
        params.text !== undefined
          ? editShapeText(slideXmlIn, params.shape_id, params.text, format)
          : formatShapeText(slideXmlIn, params.shape_id, format),
      );

      return {
        font_size: result.fontSizePt,
        estimated_height: Number(result.estimatedHeightIn.toFixed(2)),
        box_height: Number(shape.h.toFixed(2)),
        fits: result.fits,
      };
    }),
});
