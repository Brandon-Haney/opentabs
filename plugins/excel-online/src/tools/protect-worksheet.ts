import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';

export const protectWorksheet = defineTool({
  name: 'protect_worksheet',
  displayName: 'Protect Worksheet',
  description:
    'Turn on sheet protection to lock cells against editing. By default every listed action is disallowed; set an allow_* flag to true to permit that action while the sheet stays protected. Note that Excel Online sheet protection has no password — it can be turned off with unprotect_worksheet.',
  summary: 'Lock a worksheet against editing',
  icon: 'lock',
  group: 'Worksheets',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    allow_format_cells: z.boolean().optional().describe('Allow formatting cells'),
    allow_format_columns: z.boolean().optional().describe('Allow formatting columns (width, hide)'),
    allow_format_rows: z.boolean().optional().describe('Allow formatting rows (height, hide)'),
    allow_insert_columns: z.boolean().optional().describe('Allow inserting columns'),
    allow_insert_rows: z.boolean().optional().describe('Allow inserting rows'),
    allow_delete_columns: z.boolean().optional().describe('Allow deleting columns'),
    allow_delete_rows: z.boolean().optional().describe('Allow deleting rows'),
    allow_sort: z.boolean().optional().describe('Allow sorting'),
    allow_auto_filter: z.boolean().optional().describe('Allow using AutoFilter'),
    allow_edit_objects: z.boolean().optional().describe('Allow editing objects (charts, shapes)'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
  }),
  handle: async params => {
    const optionMap: Record<string, boolean | undefined> = {
      allowFormatCells: params.allow_format_cells,
      allowFormatColumns: params.allow_format_columns,
      allowFormatRows: params.allow_format_rows,
      allowInsertColumns: params.allow_insert_columns,
      allowInsertRows: params.allow_insert_rows,
      allowDeleteColumns: params.allow_delete_columns,
      allowDeleteRows: params.allow_delete_rows,
      allowSort: params.allow_sort,
      allowAutoFilter: params.allow_auto_filter,
      allowEditObjects: params.allow_edit_objects,
    };
    const options: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(optionMap)) {
      if (value !== undefined) options[key] = value;
    }
    const body = Object.keys(options).length > 0 ? { options } : {};
    await workbookApi(`/worksheets('${encodeURIComponent(params.worksheet)}')/protection/protect`, {
      method: 'POST',
      body,
    });
    return { success: true };
  },
});
