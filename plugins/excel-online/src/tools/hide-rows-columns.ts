import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath, workbookApi } from '../excel-api.js';

const COLUMN_SPAN_RE = /^[A-Za-z]{1,3}(:[A-Za-z]{1,3})?$/;
const ROW_SPAN_RE = /^\d+(:\d+)?$/;

/** Expand a single column ("B") or row ("2") reference into the full-span address Graph expects ("B:B", "2:2"). */
const toSpanAddress = (span: string): string => (span.includes(':') ? span : `${span}:${span}`);

export const hideRowsColumns = defineTool({
  name: 'hide_rows_columns',
  displayName: 'Hide Rows/Columns',
  description:
    'Hide or unhide rows and columns. Column spans use letters (e.g., "B" or "B:D"), row spans use numbers (e.g., "2" or "2:5"). List one or more spans in "columns" and/or "rows". Set "hidden" to false to unhide instead of hide (default is to hide).',
  summary: 'Hide or unhide rows and columns',
  icon: 'eye-off',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    columns: z
      .array(z.string())
      .optional()
      .describe('Column spans in letter notation to hide/unhide (e.g., ["B", "D:F"])'),
    rows: z.array(z.string()).optional().describe('Row spans to hide/unhide (e.g., ["2", "5:8"])'),
    hidden: z.boolean().optional().describe('true to hide (default), false to unhide'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
    requests_sent: z.number().int().describe('Number of API requests issued'),
  }),
  handle: async params => {
    const columns = params.columns ?? [];
    const rows = params.rows ?? [];
    if (columns.length === 0 && rows.length === 0) {
      throw ToolError.validation('Provide at least one span in "columns" or "rows".');
    }
    for (const span of columns) {
      if (!COLUMN_SPAN_RE.test(span)) {
        throw ToolError.validation(`"${span}" is not a column span. Use letters like "B" or "B:D".`);
      }
    }
    for (const span of rows) {
      if (!ROW_SPAN_RE.test(span)) {
        throw ToolError.validation(`"${span}" is not a row span. Use numbers like "2" or "2:5".`);
      }
    }

    const hidden = params.hidden ?? true;
    let sent = 0;
    for (const span of columns) {
      await workbookApi(rangePath(params.worksheet, toSpanAddress(span)), {
        method: 'PATCH',
        body: { columnHidden: hidden },
      });
      sent++;
    }
    for (const span of rows) {
      await workbookApi(rangePath(params.worksheet, toSpanAddress(span)), {
        method: 'PATCH',
        body: { rowHidden: hidden },
      });
      sent++;
    }
    return { success: true, requests_sent: sent };
  },
});
