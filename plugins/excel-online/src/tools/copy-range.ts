import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { qualifiedRange, rangePath, workbookRest } from '../workbook-rest.js';

/** The `copyType` each paste option maps to. */
const COPY_TYPES = { all: 'All', values: 'Values', formats: 'Formats', formulas: 'Formulas' } as const;

export type PasteOption = keyof typeof COPY_TYPES;

export const buildCopyRangeBody = (
  sourceWorksheet: string,
  source: string,
  paste: PasteOption,
  skipBlanks: boolean,
  transpose: boolean,
): Record<string, unknown> => ({
  sourceRange: qualifiedRange(sourceWorksheet, source),
  copyType: COPY_TYPES[paste],
  skipBlanks,
  transpose,
});

export const copyRange = defineTool({
  name: 'copy_range',
  displayName: 'Copy Range',
  description:
    'Copy a range and paste it at a destination, like Copy then Paste or Paste Special. paste="all" copies ' +
    'everything; "values" pastes results without formulas or formatting; "formulas" pastes formulas (relative ' +
    'references shift); "formats" pastes formatting only, like Format Painter. skip_blanks leaves destination cells ' +
    'untouched where the source is empty; transpose swaps rows and columns. The destination is the top-left cell ' +
    'and may be on another worksheet. Runs inside the open editing session.',
  summary: 'Copy and paste a range, including paste special',
  icon: 'copy',
  group: 'Data',
  input: z.object({
    worksheet: z.string().describe('Worksheet holding the source range (e.g., "Sheet1")'),
    source: z.string().describe('Source range in A1 notation (e.g., "A1:D20")'),
    destination: z.string().describe('Destination top-left cell in A1 notation (e.g., "F1")'),
    destination_worksheet: z.string().optional().describe('Worksheet to paste into. Defaults to the source worksheet.'),
    paste: z.enum(['all', 'values', 'formats', 'formulas']).optional().describe('What to paste (default "all")'),
    skip_blanks: z
      .boolean()
      .optional()
      .describe('Leave destination cells alone where the source is blank (default false)'),
    transpose: z.boolean().optional().describe('Swap rows and columns when pasting (default false)'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    workbookRest(
      'Post',
      `${rangePath(params.destination_worksheet ?? params.worksheet, params.destination)}/copyFrom`,
      buildCopyRangeBody(
        params.worksheet,
        params.source,
        params.paste ?? 'all',
        params.skip_blanks ?? false,
        params.transpose ?? false,
      ),
    ),
});
