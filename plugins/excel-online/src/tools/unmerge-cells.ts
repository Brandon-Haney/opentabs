import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath } from '../excel-api.js';
import { workbookCall } from '../workbook-rest.js';

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
  handle: async (params, context) => {
    await workbookCall(context, 'POST', `${rangePath(params.worksheet, params.address)}/unmerge`, {});
    return { success: true };
  },
});
