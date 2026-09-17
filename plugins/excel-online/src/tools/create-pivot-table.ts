import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { qualifiedRange, workbookRest, worksheetPath } from '../workbook-rest.js';

export const buildCreatePivotTableBody = (
  name: string,
  sourceWorksheet: string,
  source: string,
  destinationWorksheet: string,
  destination: string,
): Record<string, unknown> => ({
  name,
  source: qualifiedRange(sourceWorksheet, source),
  destination: qualifiedRange(destinationWorksheet, destination),
});

export const createPivotTable = defineTool({
  name: 'create_pivot_table',
  displayName: 'Create PivotTable',
  description:
    'Create a PivotTable from a range on the workbook, like Insert → PivotTable. The source range must include a ' +
    'header row. The PivotTable starts empty; place fields with add_pivot_field, where field_index is the zero-based ' +
    'source column. For a PivotTable over a Power BI model use create_pivot_from_connection. Runs inside the open ' +
    'editing session.',
  summary: 'Create a PivotTable from a range',
  icon: 'table',
  group: 'Pivot',
  input: z.object({
    name: z.string().min(1).describe('Name for the PivotTable (e.g., "SalesPivot")'),
    worksheet: z.string().describe('Worksheet holding the source data'),
    source: z.string().describe('Source range with headers in A1 notation (e.g., "A1:D200")'),
    destination: z.string().describe('Top-left cell for the PivotTable (e.g., "H3")'),
    destination_worksheet: z
      .string()
      .optional()
      .describe('Worksheet to place the PivotTable on. Defaults to the source worksheet.'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const destinationWorksheet = params.destination_worksheet ?? params.worksheet;
    return workbookRest(
      'Post',
      `${worksheetPath(destinationWorksheet)}/pivotTables/add`,
      buildCreatePivotTableBody(params.name, params.worksheet, params.source, destinationWorksheet, params.destination),
    );
  },
});
