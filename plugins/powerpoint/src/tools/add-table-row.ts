import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsAddTableRow, podsAddTableRowOutputSchema } from '../pods-bridge.js';

export const addTableRow = defineTool({
  name: 'add_table_row',
  displayName: 'Add Table Row',
  description:
    'Insert a row into a table on the open slide, directly below an existing row — the editor’s Table Layout → ' +
    'Insert Below. Name the row with `after`: the exact visible text of any cell in it (use `get_live_outline`). ' +
    'The new row copies that row’s cell borders, fill and text formatting; `cells` fills it left to right, and ' +
    'cells left out stay empty. This writes into the live co-authoring session, so the row appears in the open ' +
    'editor within a few seconds. These edits arrive as a co-author’s, so the editor’s own Undo cannot take them ' +
    'back — pass `dry_run: true` first to inspect the revision without writing it. The deck must be open and ' +
    'active in the browser.',
  summary: 'Insert a table row below an existing row on the open slide',
  icon: 'table-rows-split',
  group: 'Slides',
  input: z.object({
    after: z
      .string()
      .min(1)
      .describe('The exact visible text of a cell in the row to insert below, e.g. the row number or its first cell.'),
    cells: z
      .array(z.string())
      .optional()
      .describe('Text for the new cells, left to right. Single-line each; omitted cells stay empty.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked.'),
  }),
  output: podsAddTableRowOutputSchema,
  handle: async params => podsAddTableRow(params.after, params.cells ?? [], params.dry_run ?? false),
});
