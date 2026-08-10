import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, EWA_ERROR_HINTS, ewaBridge, type EwaBridgeExtra } from '../bridge.js';
import {
  DATA_SOURCE_INDEX_DESCRIPTION,
  PIVOT_DATA_SOURCE_INDEX,
  SEARCH_DATA_SOURCE_INDEX,
} from './pivot-data-source.js';
import { DEFAULT_HIERARCHY_LEVEL, resolvePivotFilterTarget, SEARCH_MEMBER_PROJECTION } from './pivot-filter-target.js';

export const setPivotFilter = defineTool({
  name: 'set_pivot_filter',
  displayName: 'Set PivotTable Filter',
  description:
    'Set which members a PivotTable page filter selects — the fix for a pivot pinned to a stale value, such as a month filter still showing last period. ' +
    'Prefer member_name: pass the name ("ATL081") and the plugin resolves it against the live filter, so no id is ever guessed or carried between calls. It selects one member; use member_ids to select several or to select "All". ' +
    'This changes the numbers the PivotTable shows, and therefore every GETPIVOTDATA formula reading it — that is the intent, but say which filter changed when reporting the result. ' +
    'Applies to the live session immediately; call refresh_pivot afterwards only if the underlying model data also needs re-querying. ' +
    'PftTokenMissing means the workbook has not been allowed to query external data — call grant_data_access.',
  summary: 'Set the members a PivotTable page filter selects',
  icon: 'filter',
  group: 'Data Model',
  input: z.object({
    worksheet: z.string().describe('Worksheet hosting the PivotTable (e.g. "Sales PowerBI")'),
    field: z
      .string()
      .describe(
        'The page filter to set, by caption ("Invoice Month") or by the field_index that inspect_data_model and list_pivot_tables report',
      ),
    member_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The member to select, by name, e.g. "ATL081". Resolved against the live filter, matching case-insensitively anywhere in the model\'s full display text ("ATL081 | DOUGLASVILLE | DOUGLASVILLE"). ' +
          'A name matching nothing, or more than one member, fails the call and changes nothing — the error lists the candidates. Selects exactly one member; for several, use member_ids.',
      ),
    member_ids: z
      .array(z.number().int())
      .min(1)
      .optional()
      .describe(
        'Ids of the members to select, from get_pivot_filter_members — for selecting several members at once, or the "All" row. Never guess an id: they follow the model\'s ordering, and a wrong one selects a different member without erroring. To select everything, pass the id of "All" rather than an empty list, which the service reads as "nothing matches".',
      ),
    pivot_name: z.string().optional().describe('PivotTable name. Only needed when the worksheet hosts more than one.'),
    hierarchy_level: z
      .number()
      .int()
      .optional()
      .describe(
        'Hierarchy level the members sit at, as get_pivot_filter_members reports it in PivotFilterHierarchyItems. Defaults to 1, correct for a single-level filter.',
      ),
    data_source_index: z.number().int().optional().describe(DATA_SOURCE_INDEX_DESCRIPTION),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    if ((params.member_name === undefined) === (params.member_ids === undefined)) {
      throw ToolError.validation(
        'Pass exactly one of member_name or member_ids. member_name is the usual choice — the plugin resolves it against the live filter, so a stale or invented id cannot select the wrong member.',
      );
    }

    const target = await resolvePivotFilterTarget(params.worksheet, params.field, params.pivot_name);
    const hierarchyLevel = params.hierarchy_level ?? DEFAULT_HIERARCHY_LEVEL;

    // A name is resolved by the engine, inside the frame: it searches the live
    // filter and feeds the matching id into this same call. It happens there
    // rather than here because a tool handler never sees a bridge response, and
    // as one operation so that a name resolving to nothing — or to several
    // members — fails before anything has been applied.
    const resolveByName: EwaBridgeExtra | undefined = params.member_name
      ? {
          prep: {
            method: 'SearchPivotFilter',
            // A lookup, not a get-state call: its response describes a read, so
            // its session token and revision counters say nothing about the
            // write that follows and must not be folded into the context.
            mergesContext: false,
            options: {
              cell: target.cell,
              dataSourceIndex: params.data_source_index ?? SEARCH_DATA_SOURCE_INDEX,
              optionalPivotAnchorParameter: { AnchorType: 0, ChartId: null, AnchorValue1: -1, AnchorValue2: -1 },
              fieldId: target.fieldId,
              parentId: -1,
              searchText: params.member_name,
              hierarchyLevel,
            },
          },
          prepSelections: [
            {
              option: 'checkedItems',
              projection: SEARCH_MEMBER_PROJECTION,
              matchField: 'name',
              valueField: 'id',
              values: [params.member_name],
              asString: true,
            },
          ],
        }
      : undefined;

    return ewaBridge(
      'ApplyFilter',
      {
        parameters: {
          Location: {
            SheetName: target.cell.SheetName,
            NamedObjectName: null,
            FirstRow: target.cell.FirstRow,
            FirstColumn: target.cell.FirstColumn,
            LastRow: target.cell.FirstRow,
            LastColumn: target.cell.FirstColumn,
          },
          IsPivotFilter: true,
          FieldId: target.fieldId,
          DataSourceIndex: params.data_source_index ?? PIVOT_DATA_SOURCE_INDEX,
          AnchorType: 0,
          ChartId: null,
          AnchorValue1: -1,
          AnchorValue2: -1,
          HierarchyLevel: hierarchyLevel,
        },
        // Overwritten by the engine when a name is being resolved; the search
        // runs first and its matching id replaces this.
        checkedItems: (params.member_ids ?? []).map(String),
      },
      { ...resolveByName, errorHints: EWA_ERROR_HINTS },
    );
  },
});
