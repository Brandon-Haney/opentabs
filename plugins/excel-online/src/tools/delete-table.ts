import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';

export const deleteTable = defineTool({
  name: 'delete_table',
  displayName: 'Delete Table',
  description:
    'Delete a table by name or ID, removing both the table object and its data from the cells. To keep the data as a plain range, use convert_table_to_range instead.',
  summary: 'Delete a table',
  icon: 'trash-2',
  group: 'Tables',
  input: z.object({
    table: z.string().describe('Table name or ID'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
  }),
  handle: async params => {
    await workbookApi(`/tables('${encodeURIComponent(params.table)}')`, { method: 'DELETE' });
    return { success: true };
  },
});
