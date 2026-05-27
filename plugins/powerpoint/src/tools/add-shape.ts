import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadPptx, getSlideList, TEXT_DECODER, TEXT_ENCODER, uploadPptx } from '../pptx-utils.js';
import { addPresetShape } from '../slide-edit.js';

/**
 * A curated subset of the most commonly used DrawingML preset geometries.
 * The full list is much larger — any valid OOXML preset name will work,
 * but listing the common ones as an enum gives the agent strong guidance.
 */
const COMMON_PRESETS = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'rtTriangle',
  'diamond',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'heptagon',
  'octagon',
  'star4',
  'star5',
  'star6',
  'star8',
  'star10',
  'star12',
  'star16',
  'star24',
  'star32',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'leftRightArrow',
  'upDownArrow',
  'bentArrow',
  'uturnArrow',
  'callout1',
  'callout2',
  'callout3',
  'wedgeRectCallout',
  'wedgeRoundRectCallout',
  'wedgeEllipseCallout',
  'cloudCallout',
  'heart',
  'lightningBolt',
  'sun',
  'moon',
  'cloud',
  'smileyFace',
  'noSmoking',
  'plus',
  'chevron',
  'plaque',
  'flowChartProcess',
  'flowChartDecision',
  'flowChartConnector',
  'flowChartTerminator',
  'flowChartDocument',
] as const;

export const addShape = defineTool({
  name: 'add_shape',
  displayName: 'Add Shape',
  description:
    'Add a new preset shape (rectangle, ellipse, arrow, star, callout, ...) to a slide. ' +
    'Positions and sizes are in inches. Optional fill color, rotation, and centered text. ' +
    'The `preset` parameter accepts any DrawingML preset geometry name — common choices are listed in the enum. ' +
    'Returns the new shape id for follow-up edits via `update_shape`.',
  summary: 'Add a new preset shape (rectangle, ellipse, arrow, ...) to a slide',
  icon: 'shapes',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    slide_number: z.number().int().min(1).describe('Slide number (1-indexed)'),
    preset: z
      .string()
      .describe(
        `DrawingML preset geometry. Common values: ${COMMON_PRESETS.join(', ')}. Any valid OOXML preset name is accepted.`,
      ),
    x: z.number().describe('X offset from slide top-left in inches'),
    y: z.number().describe('Y offset from slide top-left in inches'),
    w: z.number().positive().describe('Width in inches'),
    h: z.number().positive().describe('Height in inches'),
    fill: z.string().optional().describe('Solid fill color as hex (e.g. "FFCC00")'),
    rotation: z.number().optional().describe('Rotation in degrees (clockwise)'),
    text: z.string().optional().describe('Optional text rendered inside the shape'),
    text_size: z.number().positive().optional().describe('Font size in points for inline text'),
    text_color: z.string().optional().describe('Text color as hex'),
    text_bold: z.boolean().optional().describe('Bold text'),
    text_align: z
      .enum(['left', 'center', 'right', 'justify'])
      .optional()
      .describe('Text alignment (defaults to center)'),
  }),
  output: z.object({
    new_shape_id: z.string().describe('The id of the newly created shape'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id);
    const slideFiles = getSlideList(entries);

    if (params.slide_number > slideFiles.length || params.slide_number < 1) {
      throw ToolError.notFound(`Slide ${params.slide_number} not found — presentation has ${slideFiles.length} slides`);
    }
    const file = slideFiles[params.slide_number - 1];
    if (!file) throw ToolError.notFound(`Slide ${params.slide_number} not found`);
    const slideData = entries.get(file);
    if (!slideData) throw ToolError.internal(`Slide file not found in archive: ${file}`);

    const slideXml = TEXT_DECODER.decode(slideData);
    const { xml, new_shape_id } = addPresetShape(slideXml, {
      preset: params.preset,
      x: params.x,
      y: params.y,
      w: params.w,
      h: params.h,
      rotation: params.rotation,
      fill: params.fill,
      text: params.text,
      text_formatting: {
        font_size: params.text_size,
        color: params.text_color,
        bold: params.text_bold,
        align: params.text_align,
      },
    });
    entries.set(file, TEXT_ENCODER.encode(xml));

    await uploadPptx(params.item_id, entries);
    return { new_shape_id };
  },
});
