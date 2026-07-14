import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { addressToEwaRange, bridgeOutputSchema, ewaBridge } from '../bridge.js';

/**
 * `FormatCellsV2` uses Excel's flags pattern: a `ValidMembers` bitmask selects
 * which sibling properties actually apply. These are the bits for the three
 * attributes Microsoft Graph silently drops (verified from decoded captures).
 */
const FORMAT_MEMBER_FONT = 16;
const FORMAT_MEMBER_INDENT = 256;
const FORMAT_MEMBER_TEXT_ORIENTATION = 512;
const FONT_MEMBER_STRIKETHROUGH = 128;

/**
 * Build the `FormatCellsV2` options for the attributes the standard formatting
 * tool cannot reach: strikethrough, text rotation, and indentation. Only the
 * requested attributes set their `ValidMembers` bit, so unspecified properties
 * are left untouched. Strikethrough replay is proven live; rotation and indent
 * share the same method and flag encoding.
 */
export const buildFormatAdvancedOptions = (
  worksheet: string,
  address: string,
  attrs: { strikethrough?: boolean; text_rotation?: number; indent?: number },
): Record<string, unknown> => {
  const range = addressToEwaRange(address);
  const format: Record<string, unknown> = {};
  let validMembers = 0;

  if (attrs.strikethrough !== undefined) {
    validMembers |= FORMAT_MEMBER_FONT;
    format.Font = { ValidMembers: FONT_MEMBER_STRIKETHROUGH, Strikethrough: attrs.strikethrough };
  }
  if (attrs.text_rotation !== undefined) {
    validMembers |= FORMAT_MEMBER_TEXT_ORIENTATION;
    format.TextOrientation = attrs.text_rotation;
  }
  if (attrs.indent !== undefined) {
    validMembers |= FORMAT_MEMBER_INDENT;
    format.IndentationIncrease = attrs.indent;
  }
  format.ValidMembers = validMembers;

  return {
    formatCellsMultiRange: { SheetName: worksheet, Ranges: [range] },
    format,
    activeCell: { SheetName: worksheet, FirstRow: range.FirstRow, FirstColumn: range.FirstColumn },
    options: {},
  };
};

export const formatRangeAdvanced = defineTool({
  name: 'format_range_advanced',
  displayName: 'Format Range (Advanced)',
  description:
    'Apply the cell-format attributes the standard format_range tool cannot: strikethrough, text rotation ' +
    '(degrees), and indentation level. These are silently ignored by the standard workbook API, so they are ' +
    "driven through Excel's internal service via the frame bridge. Provide at least one attribute; only the " +
    'attributes you pass are changed. Use format_range for fill, font, and alignment.',
  summary: 'Strikethrough, text rotation, and indent',
  icon: 'strikethrough',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation (e.g., "A1:C10")'),
    strikethrough: z.boolean().optional().describe('Apply or remove strikethrough on the range font'),
    text_rotation: z.number().int().optional().describe('Text rotation in degrees (e.g., 45, -90). 0 is horizontal.'),
    indent: z.number().int().min(0).optional().describe('Indentation level (0 = no indent)'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    if (params.strikethrough === undefined && params.text_rotation === undefined && params.indent === undefined) {
      throw ToolError.validation('Provide at least one of "strikethrough", "text_rotation", or "indent".');
    }
    return ewaBridge(
      'FormatCellsV2',
      buildFormatAdvancedOptions(params.worksheet, params.address, {
        strikethrough: params.strikethrough,
        text_rotation: params.text_rotation,
        indent: params.indent,
      }),
    );
  },
});
