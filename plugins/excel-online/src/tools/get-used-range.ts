import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { hasGraphAuth, isSharePoint, sharepointGetRange, workbookApi } from '../excel-api.js';
import type { RawRange } from './schemas.js';
import { rangeSchema, mapRange } from './schemas.js';

export const getUsedRange = defineTool({
  name: 'get_used_range',
  displayName: 'Get Used Range',
  description:
    'Get the smallest range that encompasses all cells with data or formatting in a worksheet. Useful for discovering the extent of data in a sheet without knowing the exact range.',
  summary: 'Get the used range of a worksheet',
  icon: 'scan',
  group: 'Ranges',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
  }),
  output: z.object({ range: rangeSchema }),
  handle: async params => {
    if (isSharePoint() && !hasGraphAuth()) {
      // Excel Services REST API does not have a usedRange endpoint.
      // Read a large range and trim trailing empty rows/columns.
      const data = await sharepointGetRange('A1:ZZ1000', params.worksheet);
      const values = data.values;
      // Trim trailing empty rows
      let lastRow = values.length - 1;
      while (lastRow >= 0 && (values[lastRow]?.every(v => v === '' || v === 0) ?? true)) lastRow--;
      const trimmed = values.slice(0, lastRow + 1);
      // Trim trailing empty columns
      let lastCol = 0;
      for (const row of trimmed) {
        for (let c = row.length - 1; c > lastCol; c--) {
          if (row[c] !== '' && row[c] !== 0) { lastCol = c; break; }
        }
      }
      const result = trimmed.map(row => row.slice(0, lastCol + 1));
      const colLetter = String.fromCharCode(65 + lastCol);
      const address = `${params.worksheet}!A1:${colLetter}${String(result.length)}`;
      return {
        range: {
          address,
          row_count: result.length,
          column_count: lastCol + 1,
          values: result,
          formulas: [],
          text: result.map(row => row.map(v => String(v ?? ''))),
          number_format: [],
        },
      };
    }
    const data = await workbookApi<RawRange>(`/worksheets('${encodeURIComponent(params.worksheet)}')/usedRange`);
    return { range: mapRange(data) };
  },
});
