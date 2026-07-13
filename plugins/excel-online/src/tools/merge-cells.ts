import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath, workbookApi } from '../excel-api.js';

export const mergeCells = defineTool({
  name: 'merge_cells',
  displayName: 'Merge Cells',
  description:
    'Merge a range into a single cell (e.g., a title banner spanning "A1:L1"). Only the upper-left cell\'s value survives — write the value first, then merge. Set across=true to merge each row of the range separately instead of the whole range.',
  summary: 'Merge a range into one cell',
  icon: 'table-cells-merge',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address to merge (e.g., "A1:L1")'),
    across: z.boolean().optional().describe('Merge each row of the range as its own merged cell (default false)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
  }),
  handle: async params => {
    await workbookApi(`${rangePath(params.worksheet, params.address)}/merge`, {
      method: 'POST',
      body: { across: params.across ?? false },
    });
    return { success: true };
  },
});
