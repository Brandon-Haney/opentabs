import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest, worksheetPath } from '../workbook-rest.js';

export const setTabColor = defineTool({
  name: 'set_tab_color',
  displayName: 'Set Tab Color',
  description: 'Set the color of a worksheet tab, or remove it with color null. Runs inside the open editing session.',
  summary: 'Color or clear a worksheet tab',
  icon: 'palette',
  group: 'Worksheets',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .describe('Tab color as "#RRGGBB", or null to remove the color'),
  }),
  output: bridgeOutputSchema,
  handle: async params => workbookRest('Patch', worksheetPath(params.worksheet), { tabColor: params.color ?? '' }),
});
