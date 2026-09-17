import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsDeleteTableRow, podsDeleteTableRowOutputSchema } from '../pods-bridge.js';

export const deleteTableRow = defineTool({
  name: 'delete_table_row',
  displayName: 'Delete Table Row',
  description:
    'Remove a row from a table on the open slide — the editor’s Table Layout → Delete Rows. Name the row with ' +
    '`row`: the exact visible text of any cell in it (use `get_live_outline`). A table’s only row cannot be ' +
    'removed. This writes into the live co-authoring session, so the row disappears from the open editor within ' +
    'a few seconds. These edits arrive as a co-author’s, so the editor’s own Undo cannot take them back — pass ' +
    '`dry_run: true` first to inspect the revision without writing it. The deck must be open and active in the ' +
    'browser.',
  summary: 'Remove a table row on the open slide',
  icon: 'trash-2',
  group: 'Slides',
  input: z.object({
    row: z
      .string()
      .min(1)
      .describe('The exact visible text of a cell in the row to remove, e.g. its row number or first cell.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked.'),
  }),
  output: podsDeleteTableRowOutputSchema,
  handle: async params => podsDeleteTableRow(params.row, params.dry_run ?? false),
});
