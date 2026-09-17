import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookCall } from '../workbook-rest.js';
import type { RawRange } from './schemas.js';
import { mapRange, rangeSchema } from './schemas.js';

export const convertTableToRange = defineTool({
  name: 'convert_table_to_range',
  displayName: 'Convert Table to Range',
  description:
    'Convert a table back into a normal cell range, removing the table object while keeping the data and its current formatting in place. The reverse of create_table.',
  summary: 'Convert a table into a plain range',
  icon: 'table-2',
  group: 'Tables',
  input: z.object({
    table: z.string().describe('Table name or ID'),
  }),
  output: z.object({ range: rangeSchema }),
  handle: async (params, context) => {
    const data = await workbookCall<RawRange>(
      context,
      'POST',
      `/tables('${encodeURIComponent(params.table)}')/convertToRange`,
      {},
    );
    return { range: mapRange(data) };
  },
});
