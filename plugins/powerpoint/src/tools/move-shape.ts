import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsMoveShape, podsShapeLayoutOutputSchema } from '../pods-bridge.js';

export const moveShape = defineTool({
  name: 'move_shape',
  displayName: 'Move Shape',
  description:
    'Move a shape — a text box, icon, picture or a table’s frame — to an exact position on a slide of the open deck. ' +
    '`left` and `top` are inches from the slide’s top-left corner; pass either or both. Use `read_slide_layout` for ' +
    'names and current positions. Moving a table does not move shapes laid over it (such as status icons); move ' +
    'those too. ' +
    'This writes into the live co-authoring session, so the change appears in the open editor within a few ' +
    'seconds, and the editor’s own Undo cannot take it back. The deck must be open and active in the browser.',
  summary: 'Move a shape or table to an exact position',
  icon: 'move',
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
    left: z.number().optional().describe('New left edge, inches from the slide’s left side.'),
    top: z.number().optional().describe('New top edge, inches from the slide’s top.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked.'),
  }),
  output: podsShapeLayoutOutputSchema,
  handle: async params =>
    podsMoveShape(
      { slideIndex: params.slide, shape: params.shape, occurrence: params.occurrence },
      { left: params.left, top: params.top },
      params.dry_run ?? false,
    ),
});
