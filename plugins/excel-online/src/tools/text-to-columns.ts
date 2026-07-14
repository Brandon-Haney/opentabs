import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { bridgeOutputSchema, ewaBridge, viewportSelection } from '../bridge.js';

const DELIMITERS = ['tab', 'semicolon', 'comma', 'space', 'custom'] as const;

export const textToColumns = defineTool({
  name: 'text_to_columns',
  displayName: 'Text to Columns',
  description:
    'Split a single column of delimited text into multiple columns (e.g., "East-Alpha" into "East" and "Alpha"). ' +
    'Choose a "delimiter" — tab, semicolon, comma, space, or custom (then set "custom_delimiter" to the single ' +
    'character). Results are written across columns starting at the source column, overwriting the cells to its ' +
    'right; pass "destination" to write elsewhere. Not available through the standard workbook API — driven through ' +
    "Excel's internal service via the frame bridge.",
  summary: 'Split delimited text into columns',
  icon: 'columns-3',
  group: 'Ranges',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Single-column bounded range of delimited text to split (e.g., "A2:A100")'),
    delimiter: z.enum(DELIMITERS).describe('Delimiter to split on'),
    custom_delimiter: z
      .string()
      .length(1)
      .optional()
      .describe('The single delimiter character (required when delimiter is "custom")'),
    treat_consecutive_as_one: z
      .boolean()
      .optional()
      .describe('Treat consecutive delimiters as a single delimiter (default false)'),
    destination: z
      .string()
      .optional()
      .describe('Top-left cell to write results (A1 notation, e.g., "C2"); defaults to splitting in place'),
    override_nonblank: z.boolean().optional().describe('Overwrite existing data in destination cells (default false)'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const source = parseBoundedRange(params.address);
    if (source.startCol !== source.endCol) {
      throw ToolError.validation(
        'Text to Columns operates on one column. Provide a single-column range (e.g., "A2:A100").',
      );
    }
    const customChar = params.custom_delimiter;
    if (params.delimiter === 'custom' && customChar === undefined) {
      throw ToolError.validation('A "custom" delimiter requires "custom_delimiter" (a single character).');
    }
    const destination = params.destination ? parseBoundedRange(params.destination) : source;
    const isCustom = params.delimiter === 'custom';

    return ewaBridge(
      'TextToColumns',
      {
        textToColumnsInput: {
          Delimiters: {
            IsTab: params.delimiter === 'tab',
            IsSemicolon: params.delimiter === 'semicolon',
            IsComma: params.delimiter === 'comma',
            IsSpace: params.delimiter === 'space',
            IsConsecutive: params.treat_consecutive_as_one ?? false,
            IsCustom: isCustom,
            CustomDelim: isCustom && customChar !== undefined ? customChar.charCodeAt(0) : 0,
          },
          SelectedSourceRange: {
            SheetName: params.worksheet,
            NamedObjectName: '',
            FirstRow: source.startRow,
            LastRow: source.endRow,
            FirstColumn: source.startCol,
            LastColumn: source.endCol,
          },
          DestinationCell: {
            SheetName: params.worksheet,
            NamedObjectName: '',
            FirstRow: destination.startRow,
            FirstColumn: destination.startCol,
          },
          OverrideNonBlankCells: params.override_nonblank ?? false,
        },
      },
      { contextPatch: viewportSelection(params.worksheet, params.address) },
    );
  },
});
