import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, EWA_ERROR_HINTS, ewaBridgeRead, pivotCellBounds } from '../bridge.js';
import { PIVOT_DATA_SOURCE_INDEX } from './pivot-data-source.js';
import { PIVOT_WRITE_PROJECTION, pivotVersionPrep } from './pivot-field-versions.js';

/**
 * Axis codes a field can currently occupy, as the source of a removal.
 *
 * Same numbering the destination side uses, minus the "removed" and "default"
 * values, which are not places a field can be.
 */
const SOURCE_AXIS = { rows: 1, columns: 2, filters: 4, values: 8 } as const;

/** Destination axis meaning "taken out of the pivot". */
const AXIS_REMOVED = 0;

/** `ItemType` on a removal, regardless of whether the field is a measure or a hierarchy. */
const ITEM_TYPE_REMOVAL = 0;

export const removePivotField = defineTool({
  name: 'remove_pivot_field',
  displayName: 'Remove PivotTable Field',
  description:
    'Take a field out of a PivotTable zone — the inverse of add_pivot_field, and what makes adding a field safely reversible. ' +
    'Every argument comes from get_pivot_field_layout: zone is whichever axis array the field appears in, field_index is its PivotCacheIndex, and position is its index within that array. The concurrency counters are read and applied inside the same call, so they are not arguments. ' +
    'Removing a field from rows or columns changes what a GETPIVOTDATA formula reading this pivot returns, because those formulas resolve to the grand total. Unlike add_pivot_field this is not refused, since removing is how you undo an unwanted change — but check for such formulas first if the pivot is one a scorecard depends on. ' +
    'PftTokenMissing means the workbook has not been allowed to query external data — call grant_data_access.',
  summary: 'Take a field out of a PivotTable zone',
  icon: 'list-minus',
  group: 'Data Model',
  input: z.object({
    worksheet: z.string().describe('Worksheet hosting the PivotTable (e.g. "Sales PowerBI")'),
    cell: z.string().describe('Any cell inside the PivotTable, in A1 notation — its anchor is a safe choice'),
    field_index: z
      .number()
      .int()
      .describe('PivotCacheIndex of the field to remove, from get_pivot_field_layout. The same id it was added with.'),
    zone: z
      .enum(['rows', 'columns', 'filters', 'values'])
      .describe('Zone the field currently occupies — the axis array of get_pivot_field_layout it appears in'),
    position: z
      .number()
      .int()
      .describe('Zero-based position of the field within that zone, i.e. its index in that axis array'),
  }),
  output: bridgeOutputSchema.extend({
    response: z
      .number()
      .nullable()
      .describe('Document revision after the write. It advances when the field was removed; null if the call failed.'),
  }),
  handle: async params =>
    ewaBridgeRead<number | null>(
      'ApplyPivot',
      {
        cell: pivotCellBounds(params.worksheet, params.cell),
        dataSourceIndex: PIVOT_DATA_SOURCE_INDEX,
        optionalPivotAnchorParameter: { AnchorType: 0 },
        // Version fields supplied by the prep — see pivotVersionPrep.
        pivotFieldApplyData: {
          FieldListType: 1,
          SourceAxis: SOURCE_AXIS[params.zone],
          SourceAxisPosition: params.position,
          ItemType: ITEM_TYPE_REMOVAL,
          ItemIndex: params.field_index,
          DestinationAxis: AXIS_REMOVED,
          DestinationAxisPosition: -1,
        },
      },
      {
        ...pivotVersionPrep(params.worksheet, params.cell),
        projection: PIVOT_WRITE_PROJECTION,
        errorHints: EWA_ERROR_HINTS,
      },
    ),
});
