import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest, worksheetPath } from '../workbook-rest.js';

/** The `positionType` each placement maps to. Placing the copy next to a named sheet is refused by this surface. */
export const COPY_POSITIONS = { beginning: 'Beginning', end: 'End' } as const;

export const copyWorksheet = defineTool({
  name: 'copy_worksheet',
  displayName: 'Copy Worksheet',
  description:
    'Duplicate a worksheet with its data, formatting and comments, like Duplicate on the sheet tab menu. The copy ' +
    'is named "<name> (2)" and placed at the end of the workbook, or at the beginning; rename it ' +
    "afterwards with update_worksheet. The response carries the new sheet's name and position. Runs inside the " +
    'open editing session.',
  summary: 'Duplicate a worksheet',
  icon: 'copy',
  group: 'Worksheets',
  input: z.object({
    worksheet: z.string().describe('Worksheet to duplicate'),
    position: z.enum(['beginning', 'end']).optional().describe('Where to place the copy (default "end")'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    workbookRest('Post', `${worksheetPath(params.worksheet)}/copy`, {
      positionType: COPY_POSITIONS[params.position ?? 'end'],
    }),
});
