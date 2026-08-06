import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { EWA_GET_CONTEXT_KEYS, bridgeReadOutputSchema, ewaBridgeRead } from '../bridge.js';
import { FILTER_DATA_SOURCE_INDEX, resolvePivotFilterTarget } from './pivot-filter-target.js';

/**
 * Read the members of a PivotTable page filter, with the id each one is set by.
 *
 * This is the lookup set_pivot_filter depends on, and it is not optional: the
 * ids follow the model's own ordering, not the display order, so on a live
 * month filter "JUN - 2026" is 12, "JUL - 2026" is 15 and "SEP - 2025" is 18.
 * Anything that infers an id from position sets the wrong member silently.
 */
export const getPivotFilterMembers = defineTool({
  name: 'get_pivot_filter_members',
  displayName: 'Get PivotTable Filter Members',
  description:
    'List the members of a PivotTable page filter — every value the filter can be set to, each with the numeric id set_pivot_filter takes, and which are currently selected. ' +
    'Always call this before set_pivot_filter, and never reuse ids across filters or sessions: they are assigned per filter tree, so the same month is id 15 on one pivot and id 3 on another. Guessing selects the wrong member with no error. ' +
    'Members arrive under `response.Result.PivotFilterItemsList.PivotFilterItems` — an "All" root whose own PivotFilterItems holds the members, each with DisplayString, Id and State (0 selected, 1 not, 2 partial). ' +
    'Reads the live session, so it reflects unsaved filter changes. ' +
    'A PftTokenMissing error means the workbook has not been allowed to query its external data this session: the user must open a PivotTable filter in Excel and answer Yes to the "Query and Refresh Data" prompt. Ask them — that consent cannot be sent from here, and retrying will not help.',
  summary: "List a page filter's members and their ids",
  icon: 'list-filter',
  group: 'Data Model',
  input: z.object({
    worksheet: z.string().describe('Worksheet hosting the PivotTable (e.g. "Sales PowerBI")'),
    field: z
      .string()
      .describe(
        'The page filter to read, by caption ("Invoice Month") or by the field_index that inspect_data_model and list_pivot_tables report',
      ),
    pivot_name: z.string().optional().describe('PivotTable name. Only needed when the worksheet hosts more than one.'),
  }),
  output: bridgeReadOutputSchema,
  handle: async params => {
    const target = await resolvePivotFilterTarget(params.worksheet, params.field, params.pivot_name);
    return ewaBridgeRead(
      'GetPivotFilterData',
      {
        cell: target.cell,
        dataSourceIndex: FILTER_DATA_SOURCE_INDEX,
        optionalPivotAnchorParameter: { AnchorType: 0, ChartId: null, AnchorValue1: -1, AnchorValue2: -1 },
        fieldId: target.fieldId,
        parentId: -1,
        needConnect: true,
      },
      { httpMethod: 'GET', contextKeys: EWA_GET_CONTEXT_KEYS },
    );
  },
});
