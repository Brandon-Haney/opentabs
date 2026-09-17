import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsDuplicateShape, podsShapeLayoutOutputSchema } from '../pods-bridge.js';

export const duplicateShapeLive = defineTool({
  name: 'duplicate_shape_live',
  displayName: 'Duplicate Shape (Live)',
  description:
    'Copy a shape on a slide of the open deck — the editor’s Ctrl+D — and place the copy at an exact position. ' +
    'The copy keeps the source’s name, so pick it out afterwards with `occurrence`. The copy keeps the source’s look (fill, outline, size, text). Use it to add ' +
    'another icon like an existing one, e.g. a status dot of the right colour placed on a table row found with ' +
    '`read_slide_layout`. Tables cannot be copied. ' +
    'This writes into the live co-authoring session, so the change appears in the open editor within a few ' +
    'seconds, and the editor’s own Undo cannot take it back. The deck must be open and active in the browser.',
  summary: 'Copy a shape to an exact position on the open slide',
  icon: 'copy-plus',
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
    left: z.number().optional().describe('The copy’s left edge, inches; the source’s when omitted.'),
    top: z.number().optional().describe('The copy’s top edge, inches; the source’s when omitted.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked.'),
  }),
  output: podsShapeLayoutOutputSchema,
  handle: async params =>
    podsDuplicateShape(
      { slideIndex: params.slide, shape: params.shape, occurrence: params.occurrence },
      { left: params.left, top: params.top },
      params.dry_run ?? false,
    ),
});
