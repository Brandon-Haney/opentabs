import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';

export const unprotectWorksheet = defineTool({
  name: 'unprotect_worksheet',
  displayName: 'Unprotect Worksheet',
  description: 'Turn off sheet protection, unlocking all cells for editing.',
  summary: 'Unlock a protected worksheet',
  icon: 'lock-open',
  group: 'Worksheets',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
  }),
  handle: async params => {
    await workbookApi(`/worksheets('${encodeURIComponent(params.worksheet)}')/protection/unprotect`, {
      method: 'POST',
      body: {},
    });
    return { success: true };
  },
});
