import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath, workbookApi } from '../excel-api.js';

const COLUMN_SPAN_RE = /^[A-Za-z]{1,3}(:[A-Za-z]{1,3})?$/;
const ROW_SPAN_RE = /^\d+(:\d+)?$/;

/** Expand a single column ("B") or row ("2") reference into the full-span address Graph expects ("B:B", "2:2"). */
const toSpanAddress = (span: string): string => (span.includes(':') ? span : `${span}:${span}`);

export const setDimensions = defineTool({
  name: 'set_dimensions',
  displayName: 'Set Dimensions',
  description:
    'Set column widths and row heights, or autofit them to their content. Column spans use letters (e.g., "B" or "B:D"), row spans use numbers (e.g., "2" or "2:5"). Widths and heights are in points. Autofit sizes the columns/rows intersecting the given range to fit their current content.',
  summary: 'Set column widths, row heights, or autofit',
  icon: 'ruler-dimension-line',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    columns: z
      .array(
        z.object({
          columns: z.string().describe('Column or column span in letter notation (e.g., "B" or "B:D")'),
          width: z.number().positive().describe('Column width in points'),
        }),
      )
      .optional()
      .describe('Column width assignments'),
    rows: z
      .array(
        z.object({
          rows: z.string().describe('Row or row span (e.g., "2" or "2:5")'),
          height: z.number().positive().describe('Row height in points'),
        }),
      )
      .optional()
      .describe('Row height assignments'),
    autofit_columns: z
      .string()
      .optional()
      .describe('Range whose columns are autofit to content (e.g., "A1:L40" or "A:L")'),
    autofit_rows: z.string().optional().describe('Range whose rows are autofit to content (e.g., "A1:L40" or "2:9")'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
    requests_sent: z.number().int().describe('Number of API requests issued'),
  }),
  handle: async params => {
    const columns = params.columns ?? [];
    const rows = params.rows ?? [];
    if (columns.length === 0 && rows.length === 0 && !params.autofit_columns && !params.autofit_rows) {
      throw ToolError.validation('Provide at least one of "columns", "rows", "autofit_columns", or "autofit_rows".');
    }
    for (const spec of columns) {
      if (!COLUMN_SPAN_RE.test(spec.columns)) {
        throw ToolError.validation(`"${spec.columns}" is not a column span. Use letters like "B" or "B:D".`);
      }
    }
    for (const spec of rows) {
      if (!ROW_SPAN_RE.test(spec.rows)) {
        throw ToolError.validation(`"${spec.rows}" is not a row span. Use numbers like "2" or "2:5".`);
      }
    }

    let sent = 0;
    for (const spec of columns) {
      await workbookApi(`${rangePath(params.worksheet, toSpanAddress(spec.columns))}/format`, {
        method: 'PATCH',
        body: { columnWidth: spec.width },
      });
      sent++;
    }
    for (const spec of rows) {
      await workbookApi(`${rangePath(params.worksheet, toSpanAddress(spec.rows))}/format`, {
        method: 'PATCH',
        body: { rowHeight: spec.height },
      });
      sent++;
    }
    if (params.autofit_columns) {
      await workbookApi(`${rangePath(params.worksheet, params.autofit_columns)}/format/autofitColumns`, {
        method: 'POST',
        body: {},
      });
      sent++;
    }
    if (params.autofit_rows) {
      await workbookApi(`${rangePath(params.worksheet, params.autofit_rows)}/format/autofitRows`, {
        method: 'POST',
        body: {},
      });
      sent++;
    }
    return { success: true, requests_sent: sent };
  },
});
