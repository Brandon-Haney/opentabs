import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { parseBoundedRange } from '../a1.js';
import { bridgeOutputSchema, EWA_ERROR_HINTS, ewaBridge, richApiRequest } from '../bridge.js';
import { CUBE_COMMAND, powerBiConnectionString, qualifyDestination } from '../powerbi-connection.js';

/**
 * Lowest row (one-based) a cube PivotTable can be anchored at.
 *
 * A cube PivotTable reserves the rows *above* its anchor for the page-filter
 * block, so an anchor too close to the top of the sheet has nowhere to put it.
 * Verified against a live model, same connection and sheet, anchor the only
 * variable: `A1` fails, `A3` and `F12` succeed. Row 2 was not tested, so the
 * limit is set at the lowest row proven to work rather than the lowest that
 * might.
 *
 * The failure is worth guarding rather than passing through, because the
 * service reports it as `GeneralException` from `PivotTableCollection.add` with
 * no mention of the anchor — and because reaching it has already cost a
 * connection by the time it happens, since the connection is created earlier in
 * the same batch and survives the failed pivot.
 */
const MIN_PIVOT_ANCHOR_ROW = 3;

/**
 * Build the object-model batch Excel's Power BI pane sends for "Insert
 * PivotTable".
 *
 * Two details separate this from the table equivalent, and both were wrong in
 * an earlier hand-rolled attempt. The connection's command is the literal pair
 * `"Model"` / `"Cube"` rather than a query, and the destination passed to
 * `PivotTables.Add` is **sheet-qualified** — an unqualified cell is rejected.
 *
 * The worksheet must already exist. Excel's own pane creates it in a separate
 * prior request rather than folding it into this batch, and combining the two
 * is what made an earlier attempt fail with `InvalidSheetName`: the batch runs
 * against a session context captured before the sheet existed.
 *
 * Object path and action ids are preserved from the captured request rather
 * than renumbered, so this stays diffable against a fresh capture.
 */
const createPivotBatch = (connectionName: string, datasetId: string, pivotName: string, destination: string) => ({
  AutoKeepReference: false,
  Actions: [
    { Id: 21, ActionType: 1, Name: '', ObjectPathId: 1 },
    { Id: 22, ActionType: 1, Name: '', ObjectPathId: 20 },
    { Id: 24, ActionType: 1, Name: '', ObjectPathId: 23 },
    { Id: 25, ActionType: 4, Name: 'ShowPivotFieldList', ObjectPathId: 1, ArgumentInfo: { Arguments: [true] } },
    { Id: 27, ActionType: 1, Name: '', ObjectPathId: 3 },
    { Id: 28, ActionType: 1, Name: '', ObjectPathId: 26 },
    { Id: 30, ActionType: 1, Name: '', ObjectPathId: 29 },
    { Id: 32, ActionType: 1, Name: '', ObjectPathId: 31, L: [1, 3, 20, 23, 26, 29, 31] },
  ],
  ObjectPaths: {
    1: { Id: 1, ObjectPathType: 1, Name: '' },
    3: { Id: 3, ObjectPathType: 4, Name: 'Worksheets', ParentObjectPathId: 1 },
    20: { Id: 20, ObjectPathType: 4, Name: 'DataConnections', ParentObjectPathId: 1 },
    23: {
      Id: 23,
      ObjectPathType: 3,
      Name: 'Add',
      ParentObjectPathId: 20,
      ArgumentInfo: { Arguments: [connectionName, powerBiConnectionString(datasetId), ...CUBE_COMMAND] },
    },
    // The object model exposes no lookup of a worksheet by name — `getItem`
    // answers ApiNotFound here — so the target sheet is selected through the
    // request envelope and picked up by GetActiveWorksheet.
    26: {
      Id: 26,
      ObjectPathType: 3,
      Name: 'GetActiveWorksheet',
      ParentObjectPathId: 3,
      ArgumentInfo: { Arguments: [] },
    },
    29: { Id: 29, ObjectPathType: 4, Name: 'PivotTables', ParentObjectPathId: 26 },
    31: {
      Id: 31,
      ObjectPathType: 3,
      Name: 'Add',
      ParentObjectPathId: 29,
      // Argument 2 is a reference to object path 23, not a literal.
      ArgumentInfo: { Arguments: [pivotName, 23, destination], ReferencedObjectPathIds: [0, 23, 0] },
    },
  },
});

export const createPivotFromConnection = defineTool({
  name: 'create_pivot_from_connection',
  displayName: 'Create PivotTable from Power BI',
  description:
    'Create an empty PivotTable over a Power BI semantic model, ready for add_pivot_field to place measures into. ' +
    'This is what Excel\'s Data > Get Data from Power BI > "Insert PivotTable" does. Get dataset_id from the powerbi plugin\'s list_datasets, or from inspect_data_model for a model this workbook already uses. ' +
    'The worksheet must already exist — call add_worksheet first. Use a new, empty sheet: building a pivot beside existing content risks overwriting it as the pivot grows, and never re-shape a pivot a scorecard reads. ' +
    'CREATES A WORKBOOK CONNECTION, WHICH CANNOT BE DELETED from Excel for the web or any API — only the Excel desktop app can remove one, and each call adds another rather than reusing an existing one. Do not call it speculatively or retry it in a loop.',
  summary: 'Create a PivotTable over a Power BI semantic model',
  icon: 'table-2',
  group: 'Data Model',
  input: z.object({
    dataset_id: z.string().describe('Power BI semantic model ID (a GUID), from list_datasets or inspect_data_model'),
    worksheet: z.string().describe('Existing worksheet to place the PivotTable on. Use a new, empty sheet.'),
    anchor: z
      .string()
      .optional()
      .describe(
        `Top-left cell of the PivotTable in A1 notation. Defaults to A3. Must be on row ${MIN_PIVOT_ANCHOR_ROW} or below — the rows above the anchor hold the page-filter block, so A1 leaves nowhere to put it and the service rejects the whole call.`,
      ),
    pivot_name: z
      .string()
      .optional()
      .describe('Name for the PivotTable. Defaults to a name derived from the worksheet.'),
    connection_name: z
      .string()
      .optional()
      .describe('Name for the workbook connection it creates. Defaults to a name derived from the worksheet.'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const anchor = params.anchor ?? `A${MIN_PIVOT_ANCHOR_ROW}`;

    // Checked before the call, not after: the connection is created earlier in
    // the same batch and survives the failed pivot, so letting this through
    // costs an undeletable connection to learn nothing.
    const anchorRow = parseBoundedRange(anchor).startRow + 1;
    if (anchorRow < MIN_PIVOT_ANCHOR_ROW) {
      throw ToolError.validation(
        `Anchor "${anchor}" is on row ${anchorRow}; a PivotTable over a cube needs row ${MIN_PIVOT_ANCHOR_ROW} or below. ` +
          'The rows above the anchor hold the page-filter block, so there is nowhere to put it this near the top of the sheet. ' +
          `The service rejects this as a GeneralException from PivotTableCollection.add without mentioning the anchor, and the connection is created before it fails — so retrying at A1 leaves an undeletable connection behind each time. Use A${MIN_PIVOT_ANCHOR_ROW} or lower.`,
      );
    }

    const base = params.worksheet.replace(/[^A-Za-z0-9]/g, '') || 'PowerBI';
    return ewaBridge(
      'ExecuteRichApiRequest',
      richApiRequest(
        params.worksheet,
        anchor,
        createPivotBatch(
          params.connection_name ?? `PowerBI_${base}`,
          params.dataset_id,
          params.pivot_name ?? `Pivot_${base}`,
          qualifyDestination(params.worksheet, anchor),
        ),
      ),
      { errorHints: EWA_ERROR_HINTS },
    );
  },
});
