import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookApi } from '../excel-api.js';

/**
 * Resource path to a table column's filter. A column is addressed by header
 * name (`columns('Region')`) or by zero-based position (`columns/itemAt(index=N)`);
 * a numeric `column` uses the positional form so callers need not know the
 * exact header text.
 */
const columnFilterPath = (table: string, column: string | number): string => {
  const base = `/tables('${encodeURIComponent(table)}')`;
  const col =
    typeof column === 'number' ? `/columns/itemAt(index=${column})` : `/columns('${encodeURIComponent(column)}')`;
  return `${base}${col}/filter/apply`;
};

/**
 * Build the Graph `criteria` (WorkbookFilterCriteria) for a column filter. A
 * values filter keeps rows whose cell matches one of `values`; a custom filter
 * keeps rows matching one or two comparison expressions (e.g. ">100"), combined
 * via and/or.
 */
const buildCriteria = (params: {
  values?: string[];
  criterion1?: string;
  criterion2?: string;
  operator?: 'and' | 'or';
}): Record<string, unknown> | null => {
  if (params.values && params.values.length > 0) {
    return { filterOn: 'values', values: params.values };
  }
  if (params.criterion1 !== undefined) {
    const criteria: Record<string, unknown> = { filterOn: 'custom', criterion1: params.criterion1 };
    if (params.criterion2 !== undefined) {
      criteria.criterion2 = params.criterion2;
      criteria.operator = params.operator ?? 'and';
    }
    return criteria;
  }
  return null;
};

export const filterTable = defineTool({
  name: 'filter_table',
  displayName: 'Filter Table',
  description:
    'Filter a table by one of its columns, hiding rows that do not match. Filter either by a set of values ("values" — keeps rows matching any of them) or by a custom criterion ("criterion1", e.g. ">100" or "=North", optionally combined with "criterion2" via "operator" and/or). "column" is the column header name or its zero-based index. Call once per column to filter on multiple columns — each call preserves prior column filters. Use clear_table_filters to remove filters.',
  summary: 'Filter a table by a column',
  icon: 'filter',
  group: 'Tables',
  input: z.object({
    table: z.string().describe('Table name or ID'),
    column: z
      .union([z.string(), z.number().int().min(0)])
      .describe('Column to filter, by header name (e.g. "Region") or zero-based index (e.g. 0)'),
    values: z
      .array(z.string())
      .optional()
      .describe('Keep rows whose column cell matches any of these values (values filter)'),
    criterion1: z
      .string()
      .optional()
      .describe('Custom comparison, e.g. ">100", "<=50", "=North", "<>0" (custom filter)'),
    criterion2: z.string().optional().describe('Second comparison, combined with criterion1 via "operator"'),
    operator: z
      .enum(['and', 'or'])
      .optional()
      .describe('How to combine criterion1 and criterion2 (default "and"); ignored without criterion2'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the filter was applied'),
  }),
  handle: async params => {
    const criteria = buildCriteria(params);
    if (criteria === null) {
      throw ToolError.validation('Provide "values" or "criterion1" to define how the column should be filtered.');
    }

    await workbookApi(columnFilterPath(params.table, params.column), {
      method: 'POST',
      retryNonIdempotent: true,
      body: { criteria },
    });

    return { success: true };
  },
});
