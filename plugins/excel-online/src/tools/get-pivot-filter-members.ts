import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, EWA_ERROR_HINTS, EWA_GET_CONTEXT_KEYS, ewaBridgeRead } from '../bridge.js';
import {
  DATA_SOURCE_INDEX_DESCRIPTION,
  PIVOT_DATA_SOURCE_INDEX,
  SEARCH_DATA_SOURCE_INDEX,
} from './pivot-data-source.js';
import {
  DEFAULT_HIERARCHY_LEVEL,
  MEMBER_PROJECTION,
  resolvePivotFilterTarget,
  SEARCH_MEMBER_PROJECTION,
} from './pivot-filter-target.js';

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
const memberSchema = z.object({
  name: z.string().describe('Display text of the member, e.g. "JUL - 2026" or "All"'),
  id: z
    .number()
    .int()
    .describe('Id to pass to set_pivot_filter. Valid only for this filter, and only until it changes.'),
  state: z.number().int().describe('0 selected, 1 not selected, 2 partially selected (an "All" row above a mixed set)'),
  is_leaf: z.boolean().describe('False for a grouping row such as "All" or a level above the leaves'),
  list_truncated: z
    .boolean()
    .describe(
      'True when the service capped this row\'s children rather than returning them all — the list below it is partial. Narrow with "search" rather than treating it as complete.',
    ),
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
    "List a PivotTable page filter's members, each with the numeric id set_pivot_filter takes. " +
    'Pass "search" to find one by name — the service matches and returns only the hits, the only workable route on a large dimension, whose full list comes back capped. ' +
    'Without it you get the top of the tree; a large dimension\'s children arrive only when its "All" id is passed back as parent_id. ' +
    "Returns a flat list of {name, id, state, is_leaf, list_truncated}: state 0 is selected now; list_truncated true means the service capped that row's children. " +
    'Never guess or reuse an id — a wrong one selects a different member and reports no error. ' +
    'If a filter answers with far fewer members than it has, try data_source_index — Excel addresses different pivots by different values. ' +
    'Reads the live session. ' +
    'PftTokenMissing means the workbook has not been allowed to query external data — call grant_data_access.',
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
    search: z
      .string()
      .optional()
      .describe(
        'Find members whose name matches this text, e.g. "ATL081". The service does the matching and returns only the hits, ' +
          'so this is how to reach one member of a large dimension without pulling the whole list. Searches the entire filter, not one branch.',
      ),
    data_source_index: z.number().int().optional().describe(DATA_SOURCE_INDEX_DESCRIPTION),
  }),
  output: bridgeOutputSchema.extend({
    response: z
      .array(memberSchema)
      .nullable()
      .describe('Every member of the filter, flattened. Null when the call failed — see `errors`.'),
  }),
  handle: async params => {
    // Refused rather than ignored: a search covers the whole filter, so honouring
    // both would silently drop whichever the caller cared about.
    if (params.search !== undefined && params.parent_id !== undefined) {
      throw ToolError.validation(
        'Pass either search or parent_id, not both: a search already covers every member of the filter, ' +
          'so scoping it to one branch is not something the service supports. Drop parent_id to search the whole filter.',
      );
    }

    const target = await resolvePivotFilterTarget(params.worksheet, params.field, params.pivot_name);

    if (params.search !== undefined) {
      return ewaBridgeRead<z.infer<typeof memberSchema>[] | null>(
        'SearchPivotFilter',
        {
          cell: target.cell,
          dataSourceIndex: params.data_source_index ?? SEARCH_DATA_SOURCE_INDEX,
          optionalPivotAnchorParameter: { AnchorType: 0, ChartId: null, AnchorValue1: -1, AnchorValue2: -1 },
          fieldId: target.fieldId,
          parentId: -1,
          searchText: params.search,
          hierarchyLevel: DEFAULT_HIERARCHY_LEVEL,
        },
        { projection: SEARCH_MEMBER_PROJECTION, errorHints: EWA_ERROR_HINTS },
      );
    }

    return ewaBridgeRead<z.infer<typeof memberSchema>[] | null>(
      'GetPivotFilterData',
      {
        cell: target.cell,
        dataSourceIndex: params.data_source_index ?? PIVOT_DATA_SOURCE_INDEX,
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
