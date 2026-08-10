import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  type BridgeProjection,
  bridgeOutputSchema,
  EWA_ERROR_HINTS,
  EWA_GET_CONTEXT_KEYS,
  ewaBridgeRead,
} from '../bridge.js';
import { PIVOT_DATA_SOURCE_INDEX } from './pivot-data-source.js';
import { resolvePivotFilterTarget } from './pivot-filter-target.js';

/**
 * Return the members as a flat `[{ name, id, state }]` list.
 *
 * The service answers with a large envelope around a tree whose nodes each
 * carry nine fields, three of which matter — roughly 200 bytes per member. A
 * date filter is a few kilobytes either way, but a store or product dimension
 * runs to thousands of members, where the unprojected response is megabytes of
 * boilerplate and would exhaust a caller's context before it found what it
 * wanted.
 *
 * Flattened rather than nested because the "All" row is itself selectable, so a
 * caller wanting "everything" needs its id alongside the individual members.
 */
const MEMBER_PROJECTION: BridgeProjection = {
  path: 'Result.PivotFilterItemsList.PivotFilterItems',
  fields: { name: 'DisplayString', id: 'Id', state: 'State', is_leaf: 'LeafItem' },
  flattenChildren: 'PivotFilterItems',
};

const memberSchema = z.object({
  name: z.string().describe('Display text of the member, e.g. "JUL - 2026" or "All"'),
  id: z
    .number()
    .int()
    .describe('Id to pass to set_pivot_filter. Valid only for this filter, and only until it changes.'),
  state: z.number().int().describe('0 selected, 1 not selected, 2 partially selected (an "All" row above a mixed set)'),
  is_leaf: z.boolean().describe('False for a grouping row such as "All" or a level above the leaves'),
});

/**
 * Read the members of a PivotTable page filter, with the id each one is set by.
 *
 * This is the lookup set_pivot_filter depends on, and it is not optional: the
 * ids follow the model's own ordering, not the display order, so on a live
 * month filter "JUN - 2026" is 12, "JUL - 2026" is 15 and "SEP - 2025" is 18.
 * Anything that infers an id from position sets the wrong member silently.
 *
 * The service answers one level of the tree at a time. A small filter such as a
 * list of months arrives fully populated from the root, but a dimension the size
 * of a store or product list answers with "All" alone and no members under it;
 * those arrive only when that row's id is passed back as `parent_id`.
 */
export const getPivotFilterMembers = defineTool({
  name: 'get_pivot_filter_members',
  displayName: 'Get PivotTable Filter Members',
  description:
    'List the members of a PivotTable page filter — every value the filter can be set to, each with the numeric id set_pivot_filter takes, and which are currently selected. ' +
    'Always call this before set_pivot_filter, and never reuse ids across filters or sessions: they are assigned per filter tree, so the same month is id 15 on one pivot and id 3 on another. Guessing selects the wrong member with no error. ' +
    'Returns `response` as a flat list of {name, id, state, is_leaf}, including the selectable "All" row. Match on name; state 0 marks what is selected now. ' +
    'A large dimension comes back as a single unexpanded "All" row — pass its id as parent_id to list the members beneath it. ' +
    'Reads the live session, so it reflects unsaved filter changes. ' +
    "A PftTokenMissing error means this pivot's data source has not been allowed to be queried in this browser session; the error itself says exactly what the user must do.",
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
    parent_id: z
      .number()
      .int()
      .optional()
      .describe(
        'Id of the member whose children to list. Omit to read the top of the tree. ' +
          'A large dimension comes back as a single unexpanded row — "All" with is_leaf false and no members under it — ' +
          'and its children only arrive when its id is passed back here.',
      ),
  }),
  output: bridgeOutputSchema.extend({
    response: z
      .array(memberSchema)
      .nullable()
      .describe('Every member of the filter, flattened. Null when the call failed — see `errors`.'),
  }),
  handle: async params => {
    const target = await resolvePivotFilterTarget(params.worksheet, params.field, params.pivot_name);
    return ewaBridgeRead<z.infer<typeof memberSchema>[] | null>(
      'GetPivotFilterData',
      {
        cell: target.cell,
        dataSourceIndex: PIVOT_DATA_SOURCE_INDEX,
        optionalPivotAnchorParameter: { AnchorType: 0, ChartId: null, AnchorValue1: -1, AnchorValue2: -1 },
        fieldId: target.fieldId,
        parentId: params.parent_id ?? -1,
        // True only on the call that opens the tree, which is the one that has
        // to reach the model; expanding a node runs against the connection that
        // call established. Excel's own client sends exactly this pair.
        needConnect: params.parent_id === undefined,
      },
      {
        httpMethod: 'GET',
        contextKeys: EWA_GET_CONTEXT_KEYS,
        projection: MEMBER_PROJECTION,
        errorHints: EWA_ERROR_HINTS,
      },
    );
  },
});
