import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { workbookCall } from '../workbook-rest.js';
import type { GraphListResponse, RawNamedItem } from './schemas.js';
import { mapNamedItem, namedItemSchema } from './schemas.js';

export const listNamedItems = defineTool({
  name: 'list_named_items',
  displayName: 'List Named Items',
  description:
    'List all named items (named ranges, constants) in the workbook. Named items are user-defined names that refer to ranges, values, or formulas.',
  summary: 'List named ranges and constants',
  icon: 'tag',
  group: 'Workbook',
  input: z.object({}),
  output: z.object({ items: z.array(namedItemSchema) }),
  handle: async (_params, context) => {
    const data = await workbookCall<GraphListResponse<RawNamedItem>>(context, 'GET', '/names');
    return { items: (data.value ?? []).map(mapNamedItem) };
  },
});
