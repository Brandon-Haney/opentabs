import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest, worksheetPath } from '../workbook-rest.js';

/** The page-layout fields worth returning; the service serves them only when selected. */
export const PAGE_SETUP_FIELDS = [
  'orientation',
  'paperSize',
  'topMargin',
  'bottomMargin',
  'leftMargin',
  'rightMargin',
  'headerMargin',
  'footerMargin',
  'centerHorizontally',
  'centerVertically',
  'printGridlines',
  'printHeadings',
  'printComments',
  'printOrder',
  'zoom',
] as const;

export const getPageSetup = defineTool({
  name: 'get_page_setup',
  displayName: 'Get Page Setup',
  description:
    'Read how a worksheet prints: orientation, paper size, margins (in points; 72 points = 1 inch), centering, ' +
    'whether gridlines and headings print, and zoom (scale, or horizontalFitToPages/verticalFitToPages). The ' +
    'response is the OData JSON string. Runs inside the open editing session.',
  summary: 'Read a worksheet page setup',
  icon: 'printer',
  group: 'Layout',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    workbookRest('Get', `${worksheetPath(params.worksheet)}/pageLayout?$select=${PAGE_SETUP_FIELDS.join(',')}`),
});
