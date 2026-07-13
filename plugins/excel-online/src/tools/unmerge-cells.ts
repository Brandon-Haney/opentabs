import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath, workbookApi } from '../excel-api.js';

export const unmergeCells = defineTool({
  name: 'unmerge_cells',
  displayName: 'Unmerge Cells',
  description: 'Unmerge any merged cells within a range, splitting them back into individual cells.',
  summary: 'Split merged cells back apart',
  icon: 'table-cells-split',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address to unmerge (e.g., "A1:L1")'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
  }),
  handle: async params => {
    await workbookApi(`${rangePath(params.worksheet, params.address)}/unmerge`, { method: 'POST', body: {} });
    return { success: true };
  },
});
