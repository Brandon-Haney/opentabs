import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, pivotCellBounds } from '../bridge.js';
import { findGetPivotDataReferences } from '../pivot-model.js';
import { fetchWorkbookPackage } from '../workbook-package.js';

/**
 * Zones a field can be placed into, and the axis code each maps to.
 *
 * The service uses a bit-flag enum; every value here was observed on live
 * traffic rather than inferred. `default` lets Excel choose, which for a measure
 * means Values.
 */
const DESTINATION_AXIS = {
  rows: 1,
  columns: 2,
  filters: 4,
  values: 8,
  default: -1,
} as const;

/**
 * Zones whose contents change what a `GETPIVOTDATA` call returns.
 *
 * A `GETPIVOTDATA` with no field/item arguments resolves to the pivot's grand
 * total. Adding to Rows or Columns re-shapes that total; adding to Values or
 * Filters does not.
 */
const ZONES_THAT_RESHAPE_TOTALS = new Set<string>(['rows', 'columns']);

/** What kind of field is being placed — measures and hierarchies are distinct. */
const ITEM_TYPE = { measure: 3, field: 5 } as const;

export const addPivotField = defineTool({
  name: 'add_pivot_field',
  displayName: 'Add PivotTable Field',
  description:
    'Place a measure or hierarchy into a PivotTable zone (rows, columns, filters, or values). ' +
    'This is how a field the model exposes but the pivot does not yet show becomes readable by GETPIVOTDATA — inspect_data_model lists those as is_laid_out false and reports the field_index to pass here. ' +
    'field_list_version and field_well_version must be current values from get_pivot_field_layout — they change after every modification. ' +
    'Adding to rows or columns is REFUSED when a GETPIVOTDATA formula reads this pivot: those formulas resolve to the grand total, so re-shaping silently changes what they return. Values and filters are always allowed. Prefer a new pivot on its own sheet over re-shaping one a scorecard depends on. ' +
    'A PftTokenMissing error means the workbook has not been allowed to query its external data this session. Ask the user to answer Yes to Excel\'s "Query and Refresh Data" prompt; no tool can grant it.',
  summary: 'Place a measure or hierarchy into a PivotTable zone',
  icon: 'list-plus',
  group: 'Data Model',
  input: z.object({
    worksheet: z.string().describe('Worksheet hosting the PivotTable (e.g. "Sales PowerBI")'),
    cell: z.string().describe('Any cell inside the PivotTable, in A1 notation (e.g. "A4")'),
    field_index: z
      .number()
      .int()
      .describe(
        'Numeric id of the measure or hierarchy to place, as field_index from inspect_data_model (or, for a field already placed, PivotCacheIndex from get_pivot_field_layout)',
      ),
    zone: z
      .enum(['rows', 'columns', 'filters', 'values', 'default'])
      .describe('Zone to place the field into. "default" lets Excel choose, which sends a measure to Values.'),
    field_type: z.enum(['measure', 'field']).describe('Whether field_index names a measure or a dimension hierarchy'),
    field_list_version: z.number().int().describe('Current FieldListVersion from get_pivot_field_layout'),
    field_well_version: z.number().int().describe('Current FieldWellVersion from get_pivot_field_layout'),
    position: z.number().int().optional().describe('Zero-based position within the destination zone. Omit to append.'),
    data_source_index: z
      .number()
      .int()
      .optional()
      .describe('Data source index within the PivotTable. Defaults to 0, correct for a single-source pivot.'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    // Refuse a re-shape that would silently move numbers a formula already reads.
    // Checked before the write, not reported after it.
    if (ZONES_THAT_RESHAPE_TOTALS.has(params.zone)) {
      const references = await findGetPivotDataReferences(await fetchWorkbookPackage(), params.worksheet);
      if (references.length > 0) {
        const where = references
          .slice(0, 5)
          .map(reference => `${reference.worksheet}!${reference.cell}`)
          .join(', ');
        const more = references.length > 5 ? ` (and ${references.length - 5} more)` : '';
        throw ToolError.validation(
          `Refusing to add a field to ${params.zone}: ${references.length} GETPIVOTDATA formula(s) read the PivotTable on "${params.worksheet}" — ${where}${more}. ` +
            "Those formulas carry no field arguments, so they resolve to the pivot's grand total and adding to rows or columns would silently change their results. " +
            'Add to "values" or "filters" instead, which do not affect the grand total, or build a new PivotTable on its own sheet.',
        );
      }
    }

    return ewaBridge('ApplyPivot', {
      cell: pivotCellBounds(params.worksheet, params.cell),
      dataSourceIndex: params.data_source_index ?? 0,
      optionalPivotAnchorParameter: { AnchorType: 0 },
      pivotFieldApplyData: {
        FieldListType: 1,
        FieldListVersion: params.field_list_version,
        FieldWellVersion: params.field_well_version,
        SourceAxis: 0,
        SourceAxisPosition: 0,
        ItemType: ITEM_TYPE[params.field_type],
        ItemIndex: params.field_index,
        DestinationAxis: DESTINATION_AXIS[params.zone],
        DestinationAxisPosition: params.position ?? -1,
      },
    });
  },
});
