import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { workbookRest, worksheetPath } from '../workbook-rest.js';

/** Points per inch: page-layout margins are sent in points. */
const POINTS_PER_INCH = 72;

const PAPER_SIZES = ['Letter', 'Legal', 'Tabloid', 'A3', 'A4', 'A5', 'B4', 'B5', 'Executive'] as const;

export interface PageSetupInput {
  orientation?: 'portrait' | 'landscape';
  paper_size?: (typeof PAPER_SIZES)[number];
  margins_inches?: { top?: number; bottom?: number; left?: number; right?: number; header?: number; footer?: number };
  center_horizontally?: boolean;
  center_vertically?: boolean;
  print_gridlines?: boolean;
  print_headings?: boolean;
  fit_to_pages?: { wide: number; tall: number };
  scale_percent?: number;
}

/** Build the `pageLayout` PATCH body, sending only what the caller set. */
export const buildPageSetupBody = (input: PageSetupInput): Record<string, unknown> => {
  if (input.fit_to_pages && input.scale_percent !== undefined) {
    throw ToolError.validation('Pass fit_to_pages or scale_percent, not both: a page is either fitted or scaled.');
  }
  const body: Record<string, unknown> = {};
  if (input.orientation) body.orientation = input.orientation === 'landscape' ? 'Landscape' : 'Portrait';
  if (input.paper_size) body.paperSize = input.paper_size;
  const margins = input.margins_inches ?? {};
  for (const [side, value] of Object.entries(margins)) {
    if (value !== undefined) body[`${side}Margin`] = Math.round(value * POINTS_PER_INCH * 100) / 100;
  }
  if (input.center_horizontally !== undefined) body.centerHorizontally = input.center_horizontally;
  if (input.center_vertically !== undefined) body.centerVertically = input.center_vertically;
  if (input.print_gridlines !== undefined) body.printGridlines = input.print_gridlines;
  if (input.print_headings !== undefined) body.printHeadings = input.print_headings;
  if (input.fit_to_pages) {
    body.zoom = { horizontalFitToPages: input.fit_to_pages.wide, verticalFitToPages: input.fit_to_pages.tall };
  }
  if (input.scale_percent !== undefined) body.zoom = { scale: input.scale_percent };
  if (Object.keys(body).length === 0) throw ToolError.validation('Pass at least one page setting to change.');
  return body;
};

const inches = z.number().min(0).max(10);

export const setPageSetup = defineTool({
  name: 'set_page_setup',
  displayName: 'Set Page Setup',
  description:
    'Change how a worksheet prints, like Page Layout → Page Setup: orientation, paper size, margins in inches, ' +
    'centering on the page, printing gridlines and row/column headings, and scaling — either fit_to_pages (e.g. ' +
    '1 wide by 1 tall) or scale_percent. Only the settings passed change. Pair with set_print_area to limit what ' +
    'prints, and read the result back with get_page_setup. Runs inside the open editing session.',
  summary: 'Set orientation, margins, scaling and print options',
  icon: 'printer',
  group: 'Layout',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    orientation: z.enum(['portrait', 'landscape']).optional().describe('Page orientation'),
    paper_size: z.enum(PAPER_SIZES).optional().describe('Paper size'),
    margins_inches: z
      .object({
        top: inches.optional(),
        bottom: inches.optional(),
        left: inches.optional(),
        right: inches.optional(),
        header: inches.optional(),
        footer: inches.optional(),
      })
      .optional()
      .describe('Margins in inches; omit a side to leave it unchanged'),
    center_horizontally: z.boolean().optional().describe('Center the printout horizontally on the page'),
    center_vertically: z.boolean().optional().describe('Center the printout vertically on the page'),
    print_gridlines: z.boolean().optional().describe('Print cell gridlines'),
    print_headings: z.boolean().optional().describe('Print row numbers and column letters'),
    fit_to_pages: z
      .object({ wide: z.number().int().min(1), tall: z.number().int().min(1) })
      .optional()
      .describe('Shrink the printout to this many pages wide and tall'),
    scale_percent: z.number().int().min(10).max(400).optional().describe('Print at this percentage of normal size'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const { worksheet, ...settings } = params;
    return workbookRest('Patch', `${worksheetPath(worksheet)}/pageLayout`, buildPageSetupBody(settings));
  },
});
