import { defineTool, stripUndefined } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookRestCall, worksheetPath } from '../workbook-rest.js';
import type { RawWorksheet } from './schemas.js';
import { mapWorksheet, worksheetSchema } from './schemas.js';

export const updateWorksheet = defineTool({
  name: 'update_worksheet',
  displayName: 'Update Worksheet',
  description:
    'Update worksheet properties such as name, position, or visibility. Only specified fields are changed; omitted ' +
    'fields remain unchanged. Runs inside the open editing session.',
  summary: 'Update worksheet name, position, or visibility',
  icon: 'pencil',
  group: 'Worksheets',
  input: z.object({
    name: z.string().describe('Current name of the worksheet to update'),
    new_name: z.string().optional().describe('New name for the worksheet'),
    position: z.number().int().min(0).optional().describe('New zero-based position'),
    visibility: z.enum(['Visible', 'Hidden', 'VeryHidden']).optional().describe('New visibility state'),
  }),
  output: z.object({ worksheet: worksheetSchema }),
  handle: async (params, context) => {
    const body = stripUndefined({
      name: params.new_name,
      position: params.position,
      visibility: params.visibility,
    });
    const data = await workbookRestCall<RawWorksheet>(context, 'Patch', worksheetPath(params.name), body);
    if (!data) throw new Error(`Excel returned nothing for worksheet "${params.name}".`);
    return { worksheet: mapWorksheet(data) };
  },
});
