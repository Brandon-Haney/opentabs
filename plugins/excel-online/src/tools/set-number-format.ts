import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { rangePath, workbookApi } from '../excel-api.js';

/**
 * Upper bound on cells a single call may format. The Graph `numberFormat`
 * property is a full 2D grid the size of the range, so a uniform format on a
 * huge range would send an array of this many short strings in one request.
 * Beyond this the payload risks tripping workbook-API size limits; splitting
 * across calls (or formatting whole columns via their used range) stays within
 * bounds.
 */
const MAX_CELLS = 50_000;

/**
 * Common named formats mapped to their Excel number-format codes, so callers
 * can pass a friendly name instead of memorising the code syntax. Any string
 * that is not a known name is passed through verbatim as a raw format code, so
 * custom codes like `"[Red]-#,##0.00"` work directly.
 */
const NAMED_FORMATS: Record<string, string> = {
  general: 'General',
  text: '@',
  number: '#,##0.00',
  integer: '#,##0',
  currency: '$#,##0.00',
  accounting: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  percent: '0.00%',
  percent_whole: '0%',
  scientific: '0.00E+00',
  date: 'm/d/yyyy',
  date_long: 'dddd, mmmm d, yyyy',
  time: 'h:mm:ss AM/PM',
  datetime: 'm/d/yyyy h:mm AM/PM',
  fraction: '# ?/?',
  phone: '[<=9999999]###-####;(###) ###-####',
};

/** Resolve a friendly name to its format code, or pass an unknown string through as a raw code. */
const resolveFormat = (format: string): string => NAMED_FORMATS[format.toLowerCase()] ?? format;

export const setNumberFormat = defineTool({
  name: 'set_number_format',
  displayName: 'Set Number Format',
  description:
    'Set the number format of a range — how cell values are displayed (currency, percent, dates, custom codes) without changing the underlying values. Pass "format" to apply one format to the whole range, or "formats" (a 2D array matching the range dimensions) for per-cell formats. A format may be a friendly name (general, text, number, integer, currency, accounting, percent, percent_whole, scientific, date, date_long, time, datetime, fraction, phone) or a raw Excel format code (e.g. "$#,##0.00", "0.0%", "yyyy-mm-dd", "[Red](#,##0)"). The range must be bounded (explicit rows and columns).',
  summary: 'Set how cell values are displayed',
  icon: 'hash',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Bounded range address in A1 notation (e.g., "B2:B20")'),
    format: z
      .string()
      .optional()
      .describe('One format (friendly name or raw Excel code) applied uniformly to the entire range'),
    formats: z
      .array(z.array(z.string()))
      .optional()
      .describe('2D array of per-cell formats matching the range dimensions (friendly names or raw codes)'),
  }),
  output: z.object({
    cells_formatted: z.number().int().describe('Number of cells whose number format was set'),
  }),
  handle: async params => {
    if ((params.format === undefined) === (params.formats === undefined)) {
      throw ToolError.validation('Provide exactly one of "format" (uniform) or "formats" (per-cell 2D array).');
    }

    const bounds = parseBoundedRange(params.address);
    const rowCount = bounds.endRow - bounds.startRow + 1;
    const columnCount = bounds.endCol - bounds.startCol + 1;
    const cellCount = rowCount * columnCount;
    if (cellCount > MAX_CELLS) {
      throw ToolError.validation(
        `"${params.address}" covers ${cellCount} cells (limit ${MAX_CELLS}). Format a smaller range, or split it across multiple calls.`,
      );
    }

    let numberFormat: string[][];
    if (params.format !== undefined) {
      const code = resolveFormat(params.format);
      numberFormat = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => code));
    } else {
      const formats = params.formats ?? [];
      if (formats.length !== rowCount || formats.some(row => row.length !== columnCount)) {
        throw ToolError.validation(
          `"formats" must be a ${rowCount}x${columnCount} array matching the dimensions of "${params.address}".`,
        );
      }
      numberFormat = formats.map(row => row.map(resolveFormat));
    }

    await workbookApi(rangePath(params.worksheet, params.address), {
      method: 'PATCH',
      body: { numberFormat },
    });
    return { cells_formatted: cellCount };
  },
});
