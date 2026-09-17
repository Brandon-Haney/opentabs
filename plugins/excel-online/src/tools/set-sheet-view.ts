import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest, worksheetPath } from '../workbook-rest.js';

export const setSheetView = defineTool({
  name: 'set_sheet_view',
  displayName: 'Set Sheet View',
  description:
    "Show or hide a worksheet's gridlines (the faint lines between cells, not borders) and its row/column " +
    'headings, like the View tab checkboxes. The setting is saved with the workbook, so every viewer sees it. ' +
    'Runs inside the open editing session.',
  summary: 'Show or hide gridlines and headings',
  icon: 'grid',
  group: 'View',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    show_gridlines: z.boolean().optional().describe('Show the gridlines'),
    show_headings: z.boolean().optional().describe('Show row numbers and column letters'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    if (params.show_gridlines === undefined && params.show_headings === undefined) {
      throw ToolError.validation('Pass show_gridlines, show_headings, or both.');
    }
    return workbookRest('Patch', worksheetPath(params.worksheet), {
      ...(params.show_gridlines === undefined ? {} : { showGridlines: params.show_gridlines }),
      ...(params.show_headings === undefined ? {} : { showHeadings: params.show_headings }),
    });
  },
});
