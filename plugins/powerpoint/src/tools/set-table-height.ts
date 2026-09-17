import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetTableHeight, podsShapeLayoutOutputSchema } from '../pods-bridge.js';

export const setTableHeight = defineTool({
  name: 'set_table_height',
  displayName: 'Set Table Height',
  description:
    'Set a table’s total height in inches on the open deck — the editor’s Table Layout → Height — scaling every row ' +
    'in proportion. Name the table with `slide` and `table`: the exact text of any of its cells. Rows never render shorter than ' +
    'their text, so if the table stays taller than asked, make its text smaller with `set_font_size` first. Check ' +
    'the result with `read_slide_layout`, and move the table with `move_shape`. ' +
    'This writes into the live co-authoring session, so the change appears in the open editor within a few ' +
    'seconds, and the editor’s own Undo cannot take it back. The deck must be open and active in the browser.',
  summary: 'Set a table’s total height',
  icon: 'rows-3',
  group: 'Slides',
  input: z.object({
    slide: z.number().int().min(1).describe('The 1-based slide holding the table.'),
    table: z.string().min(1).describe('The exact visible text of any cell in the table.'),
    height: z.number().positive().describe('The new total height, inches.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked.'),
  }),
  output: podsShapeLayoutOutputSchema,
  handle: async params => podsSetTableHeight(params.slide, params.table, params.height, params.dry_run ?? false),
});
