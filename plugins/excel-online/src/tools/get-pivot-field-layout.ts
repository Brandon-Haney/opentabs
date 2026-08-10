import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { EWA_GET_CONTEXT_KEYS, bridgeReadOutputSchema, ewaBridgeRead, pivotCellRef } from '../bridge.js';
import { PIVOT_DATA_SOURCE_INDEX } from './pivot-data-source.js';

/**
 * Read the live field well of a PivotTable.
 *
 * This is the read half of the pivot API and the lookup the write half depends
 * on. `ApplyFilter` and `ApplyPivot` both address fields by a numeric id and
 * guard their writes with a pair of version counters; this call is where both
 * come from. It is a GET — on this service, reads put the whole request,
 * context included, in the query string.
 */
export const getPivotFieldLayout = defineTool({
  name: 'get_pivot_field_layout',
  displayName: 'Get PivotTable Field Layout',
  description:
    "Read a PivotTable's live field layout: which fields sit in Rows, Columns, Filters and Values right now, with the numeric id of each. " +
    'Unlike list_pivot_tables, which reads the saved workbook file, this reflects the pivot as it currently stands in the open session. ' +
    'The result arrives under `response.Result` with four arrays — RowAxis, ColumnAxis, FilterAxis and DataAxis — each entry carrying `Name` and `PivotCacheIndex`. ' +
    '`PivotCacheIndex` is the field id the pivot write operations take, and it is the same index inspect_data_model reports for the corresponding measure or hierarchy. ' +
    '`response.Result` also carries `FieldListVersion` and `FieldWellVersion`, the concurrency counters a subsequent write must echo — they change after every modification, so re-read them rather than reusing an old pair. ' +
    "Not available through the standard workbook API — driven through Excel's internal service via the frame bridge.",
  summary: "Read a PivotTable's live field layout and ids",
  icon: 'layout-list',
  group: 'Data Model',
  input: z.object({
    worksheet: z.string().describe('Worksheet hosting the PivotTable (e.g. "Sales PowerBI")'),
    cell: z
      .string()
      .describe('Any cell inside the PivotTable, in A1 notation — its anchor is a safe choice (e.g. "A4")'),
  }),
  output: bridgeReadOutputSchema,
  handle: async params =>
    ewaBridgeRead(
      'GetPivotFieldManagerData',
      {
        cell: pivotCellRef(params.worksheet, params.cell),
        dataSourceIndex: PIVOT_DATA_SOURCE_INDEX,
        optionalPivotAnchorParameter: { AnchorType: 0 },
        type: 1,
        version: 4,
      },
      { httpMethod: 'GET', contextKeys: EWA_GET_CONTEXT_KEYS },
    ),
});
