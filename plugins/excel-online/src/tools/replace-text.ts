import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema } from '../bridge.js';
import { rangePath, workbookRest, worksheetPath } from '../workbook-rest.js';

export const buildReplaceTextBody = (
  find: string,
  replace: string,
  matchCase: boolean,
  matchEntireCell: boolean,
): Record<string, unknown> => ({
  text: find,
  replacement: replace,
  criteria: { completeMatch: matchEntireCell, matchCase },
});

/** The range to search: the given address, or the worksheet's used range. */
export const replaceTextTarget = (worksheet: string, address?: string): string =>
  address ? rangePath(worksheet, address) : `${worksheetPath(worksheet)}/usedRange`;

export const replaceText = defineTool({
  name: 'replace_text',
  displayName: 'Find and Replace',
  description:
    'Replace every occurrence of text in a worksheet or range, like Find & Replace → Replace All. Matches inside ' +
    'cell text by default; set match_entire_cell to replace only cells whose whole content equals the search text, ' +
    'and match_case for a case-sensitive search. Omit address to search the used range of the worksheet. The ' +
    'response is {"value": <number of cells changed>}. Runs inside the open editing session.',
  summary: 'Find and replace text across a range or sheet',
  icon: 'replace',
  group: 'Data',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().optional().describe('Range to search in A1 notation. Omit to search the whole used range.'),
    find: z.string().min(1).describe('Text to find'),
    replace: z.string().describe('Replacement text ("" deletes the match)'),
    match_case: z.boolean().optional().describe('Case-sensitive match (default false)'),
    match_entire_cell: z
      .boolean()
      .optional()
      .describe('Only replace cells whose entire content matches (default false)'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    workbookRest(
      'Post',
      `${replaceTextTarget(params.worksheet, params.address)}/replaceAll`,
      buildReplaceTextBody(params.find, params.replace, params.match_case ?? false, params.match_entire_cell ?? false),
    ),
});
