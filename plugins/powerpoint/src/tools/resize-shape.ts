import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsResizeShape, podsShapeLayoutOutputSchema } from '../pods-bridge.js';

export const resizeShape = defineTool({
  name: 'resize_shape',
  displayName: 'Resize Shape',
  description:
    'Resize a shape on a slide of the open deck to an exact width and/or height in inches, keeping its top-left ' +
    'corner where it is. Tables are sized with `set_table_height` instead. Use `read_slide_layout` for names and ' +
    'current sizes. ' +
    'This writes into the live co-authoring session, so the change appears in the open editor within a few ' +
    'seconds, and the editor’s own Undo cannot take it back. The deck must be open and active in the browser.',
  summary: 'Resize a shape to an exact width and height',
  icon: 'scaling',
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
    width: z.number().positive().optional().describe('New width, inches.'),
    height: z.number().positive().optional().describe('New height, inches.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked.'),
  }),
  output: podsShapeLayoutOutputSchema,
  handle: async params =>
    podsResizeShape(
      { slideIndex: params.slide, shape: params.shape, occurrence: params.occurrence },
      { width: params.width, height: params.height },
      params.dry_run ?? false,
    ),
});
