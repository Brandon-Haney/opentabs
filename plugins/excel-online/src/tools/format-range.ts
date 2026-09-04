import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { buildRangeAddress, parseBoundedRange } from '../a1.js';
import { rangePath, workbookApi } from '../excel-api.js';
import type { CellFormat } from './schemas.js';
import { cellFormatSchema } from './schemas.js';

/**
 * Hard ceiling on Graph requests a single call may fan out to. Each formatted
 * region costs up to three requests (alignment, fill, font); beyond this the
 * call would routinely hit workbook-API throttling mid-way and leave the sheet
 * partially painted.
 */
const MAX_REQUESTS = 200;

interface FormatRequest {
  path: string;
  method: 'PATCH' | 'POST';
  body: Record<string, unknown>;
}

/** Expand one cell format into the Graph requests that apply it to `base`. */
const buildFormatRequests = (base: string, format: CellFormat): FormatRequest[] => {
  const requests: FormatRequest[] = [];
  if (format.align) {
    const body: Record<string, unknown> = {};
    if (format.align.horizontal !== undefined) body.horizontalAlignment = format.align.horizontal;
    if (format.align.vertical !== undefined) body.verticalAlignment = format.align.vertical;
    if (format.align.wrap_text !== undefined) body.wrapText = format.align.wrap_text;
    if (Object.keys(body).length > 0) requests.push({ path: `${base}/format`, method: 'PATCH', body });
  }
  if (format.fill) {
    requests.push(
      format.fill.color === null
        ? { path: `${base}/format/fill/clear`, method: 'POST', body: {} }
        : { path: `${base}/format/fill`, method: 'PATCH', body: { color: format.fill.color } },
    );
  }
  if (format.font) {
    const body: Record<string, unknown> = {};
    if (format.font.name !== undefined) body.name = format.font.name;
    if (format.font.size !== undefined) body.size = format.font.size;
    if (format.font.color !== undefined) body.color = format.font.color;
    if (format.font.bold !== undefined) body.bold = format.font.bold;
    if (format.font.italic !== undefined) body.italic = format.font.italic;
    if (format.font.underline !== undefined) body.underline = format.font.underline;
    if (Object.keys(body).length > 0) requests.push({ path: `${base}/format/font`, method: 'PATCH', body });
  }
  return requests;
};

/**
 * Canonical serialization of a cell format, used to detect identical formats
 * for region coalescing. Fixed property order makes semantically equal formats
 * compare equal regardless of input key order. Returns null for formats that
 * apply nothing.
 */
const formatKey = (format: CellFormat | null | undefined): string | null => {
  if (!format) return null;
  const canonical = {
    fill: format.fill && { color: format.fill.color },
    font: format.font && {
      name: format.font.name,
      size: format.font.size,
      color: format.font.color,
      bold: format.font.bold,
      italic: format.font.italic,
      underline: format.font.underline,
    },
    align: format.align && {
      horizontal: format.align.horizontal,
      vertical: format.align.vertical,
      wrap_text: format.align.wrap_text,
    },
  };
  const key = JSON.stringify(canonical);
  return key === '{}' ? null : key;
};

/** A rectangular block of cells sharing one format, relative to the input range's top-left. */
interface Region {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  format: CellFormat;
}

/**
 * Coalesce a per-cell format grid into maximal rectangles: horizontal runs of
 * identical formats within each row, then vertical merging of aligned runs
 * across adjacent rows. Banded rows collapse to one region per band and a
 * uniformly-styled column collapses to a single region.
 */
const coalesceRegions = (formats: readonly (readonly (CellFormat | null)[])[]): Region[] => {
  const regions: Region[] = [];
  let openAbove = new Map<string, Region>();
  for (let row = 0; row < formats.length; row++) {
    const cells = formats[row] ?? [];
    const openHere = new Map<string, Region>();
    let col = 0;
    while (col < cells.length) {
      const format = cells[col];
      const key = formatKey(format);
      if (key === null || !format) {
        col++;
        continue;
      }
      let endCol = col;
      while (endCol + 1 < cells.length && formatKey(cells[endCol + 1]) === key) endCol++;
      const runKey = `${col}:${endCol}:${key}`;
      const above = openAbove.get(runKey);
      if (above) {
        above.endRow = row;
        openHere.set(runKey, above);
      } else {
        const region: Region = { startRow: row, endRow: row, startCol: col, endCol, format };
        regions.push(region);
        openHere.set(runKey, region);
      }
      col = endCol + 1;
    }
    openAbove = openHere;
  }
  return regions;
};

export const formatRange = defineTool({
  name: 'format_range',
  displayName: 'Format Range',
  description:
    'Apply visual formatting to a range: fill color, font (name, size, color, bold, italic, underline), and alignment (horizontal, vertical, wrap text). Pass "format" to apply one format to the whole range, or "formats" (a 2D array matching the range dimensions, like update_range values) for per-cell styling — identical adjacent formats are batched, so banded rows or status-colored cells stay efficient. Use null within "formats" to leave a cell untouched, and fill color null to clear a fill.',
  summary: 'Apply fill, font, and alignment formatting',
  icon: 'paintbrush',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation (e.g., "A1:L1"). Must be bounded when using "formats".'),
    format: cellFormatSchema.optional().describe('One format applied uniformly to the entire range'),
    formats: z
      .array(z.array(cellFormatSchema.nullable()))
      .optional()
      .describe('2D array of per-cell formats matching the range dimensions. Use null to skip a cell.'),
  }),
  output: z.object({
    regions_formatted: z.number().int().describe('Number of contiguous same-format regions that were painted'),
    requests_sent: z.number().int().describe('Number of API requests issued'),
  }),
  handle: async (params, context) => {
    if ((params.format === undefined) === (params.formats === undefined)) {
      throw ToolError.validation('Provide exactly one of "format" (uniform) or "formats" (per-cell 2D array).');
    }

    if (params.format !== undefined) {
      const requests = buildFormatRequests(rangePath(params.worksheet, params.address), params.format);
      if (requests.length === 0) {
        throw ToolError.validation('The format object is empty — provide fill, font, or align properties.');
      }
      for (const request of requests) {
        await workbookApi(request.path, { method: request.method, body: request.body, retryNonIdempotent: true });
      }
      return { regions_formatted: 1, requests_sent: requests.length };
    }

    const formats = params.formats ?? [];
    const bounds = parseBoundedRange(params.address);
    const rowCount = bounds.endRow - bounds.startRow + 1;
    const columnCount = bounds.endCol - bounds.startCol + 1;
    if (formats.length !== rowCount || formats.some(row => row.length !== columnCount)) {
      throw ToolError.validation(
        `"formats" must be a ${rowCount}x${columnCount} array matching the dimensions of "${params.address}".`,
      );
    }

    const regions = coalesceRegions(formats);
    const requests = regions.flatMap(region =>
      buildFormatRequests(
        rangePath(
          params.worksheet,
          buildRangeAddress({
            startRow: bounds.startRow + region.startRow,
            endRow: bounds.startRow + region.endRow,
            startCol: bounds.startCol + region.startCol,
            endCol: bounds.startCol + region.endCol,
          }),
        ),
        region.format,
      ),
    );
    if (requests.length === 0) {
      throw ToolError.validation('Every cell in "formats" is null or empty — nothing to apply.');
    }
    if (requests.length > MAX_REQUESTS) {
      throw ToolError.validation(
        `This call needs ${requests.length} API requests (limit ${MAX_REQUESTS}). Reduce the number of distinct per-cell formats, or split the range across multiple calls.`,
      );
    }

    let sent = 0;
    for (const request of requests) {
      await workbookApi(request.path, { method: request.method, body: request.body, retryNonIdempotent: true });
      sent++;
      context?.reportProgress({ progress: sent, total: requests.length, message: `Formatting ${params.address}` });
    }
    return { regions_formatted: regions.length, requests_sent: requests.length };
  },
});
