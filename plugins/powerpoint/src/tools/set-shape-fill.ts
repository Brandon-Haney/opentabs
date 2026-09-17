import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetShapeFill, podsShapeLayoutOutputSchema } from '../pods-bridge.js';

export const setShapeFill = defineTool({
  name: 'set_shape_fill',
  displayName: 'Set Shape Fill',
  description:
    'Set the solid fill colour of a shape on a slide of the open deck — the editor’s Shape Fill. Use it to recolour ' +
    'an icon, such as a status dot, or a box. Name the shape with `slide` and `shape` as `read_slide_layout` lists ' +
    'it (which also reports each shape’s current `fillHex`). This writes into the live co-authoring session, so ' +
    'the change appears in the open editor within a few seconds, and the editor’s own Undo cannot take it back. ' +
    'The deck must be open and active in the browser.',
  summary: 'Set a shape’s fill colour',
  icon: 'paint-bucket',
  group: 'Slides',
  input: z.object({
    slide: z.number().int().min(1).describe('The 1-based slide number.'),
    shape: z.string().min(1).describe('The shape name, as `read_slide_layout` lists it.'),
    occurrence: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Which shape to use when several on the slide share the name, counting from 1. Defaults to 1.'),
    color: z
      .string()
      .regex(/^#?[0-9a-fA-F]{6}$/)
      .describe('The fill colour as 6-digit hex RRGGBB, e.g. "00B050" for green.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revisions without writing them, so the change can be checked.'),
  }),
  output: podsShapeLayoutOutputSchema,
  handle: async params =>
    podsSetShapeFill(
      { slideIndex: params.slide, shape: params.shape, occurrence: params.occurrence },
      params.color,
      params.dry_run ?? false,
    ),
});
