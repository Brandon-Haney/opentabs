import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, EWA_ERROR_HINTS, ewaBridge } from '../bridge.js';
import { FILTER_DATA_SOURCE_INDEX, resolvePivotFilterTarget } from './pivot-filter-target.js';

/**
 * Level of the hierarchy the filter selection applies to.
 *
 * Every page filter observed on a cube-backed pivot reports a single level, and
 * the service echoes it as `Level: 1` in the member list. A multi-level user
 * hierarchy would need the level the selected members sit at, which is why this
 * stays overridable rather than being folded into the request shape.
 */
const DEFAULT_HIERARCHY_LEVEL = 1;

export const setPivotFilter = defineTool({
  name: 'set_pivot_filter',
  displayName: 'Set PivotTable Filter',
  description:
    'Set which members a PivotTable page filter selects — the fix for a pivot pinned to a stale value, such as a month filter still showing last period. ' +
    "Pass member_ids from get_pivot_filter_members, which you must call first: the ids follow the model's ordering, not the displayed order, so an inferred id selects the wrong member without erroring. " +
    'Selecting several members at once is supported and aggregates them. ' +
    'This changes the numbers the PivotTable shows, and therefore every GETPIVOTDATA formula reading it — that is the intent, but say which filter changed when reporting the result. ' +
    'Applies to the live session immediately; call refresh_pivot afterwards only if the underlying model data also needs re-querying. ' +
    "A PftTokenMissing error means this pivot's data source has not been allowed to be queried in this browser session; the error itself says exactly what the user must do.",
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
    member_ids: z
      .array(z.number().int())
      .min(1)
      .describe(
        'Ids of the members to select, from get_pivot_filter_members. Several ids select several members. Never guess these. To select everything, pass the id of the "All" member rather than an empty list — the service reads an empty selection as "nothing matches", not "no filter".',
      ),
    pivot_name: z.string().optional().describe('PivotTable name. Only needed when the worksheet hosts more than one.'),
    hierarchy_level: z
      .number()
      .int()
      .optional()
      .describe(
        'Hierarchy level the members sit at, as get_pivot_filter_members reports it in PivotFilterHierarchyItems. Defaults to 1, correct for a single-level filter.',
      ),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const target = await resolvePivotFilterTarget(params.worksheet, params.field, params.pivot_name);

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
          DataSourceIndex: FILTER_DATA_SOURCE_INDEX,
          AnchorType: 0,
          ChartId: null,
          AnchorValue1: -1,
          AnchorValue2: -1,
          HierarchyLevel: params.hierarchy_level ?? DEFAULT_HIERARCHY_LEVEL,
        },
        checkedItems: params.member_ids.map(String),
      },
      { errorHints: EWA_ERROR_HINTS },
    );
  },
});
