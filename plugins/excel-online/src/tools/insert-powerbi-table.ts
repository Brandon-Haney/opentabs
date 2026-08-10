import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { EWA_ERROR_HINTS, bridgeOutputSchema, ewaBridge, richApiRequest } from '../bridge.js';
import { DAX_COMMAND_TYPE, powerBiConnectionString } from '../powerbi-connection.js';

/** Table style Excel's own Power BI pane applies to an inserted query table. */
const DEFAULT_TABLE_STYLE = 'TableStyleMedium7';

/**
 * Build the object-model batch that Excel's Power BI pane sends for "Insert
 * Table": create a connection whose *command* is a DAX query, then bind a table
 * to it.
 *
 * Object path and action ids are preserved from the captured request rather
 * than renumbered. They are internal correlation ids with no meaning beyond the
 * batch, and keeping them identical makes this diffable against a fresh capture
 * if the shape ever changes.
 */
const insertQueryTableBatch = (name: string, datasetId: string, dax: string, anchor: string, style: string) => ({
  AutoKeepReference: false,
  Actions: [
    { Id: 19, ActionType: 1, Name: '', ObjectPathId: 1 },
    { Id: 20, ActionType: 1, Name: '', ObjectPathId: 18 },
    { Id: 22, ActionType: 1, Name: '', ObjectPathId: 21 },
    { Id: 24, ActionType: 1, Name: '', ObjectPathId: 23 },
    {
      Id: 25,
      ActionType: 3,
      Name: 'SuspendScreenUpdatingUntilNextSync',
      ObjectPathId: 23,
      ArgumentInfo: { Arguments: [] },
      L: [23],
    },
    { Id: 27, ActionType: 1, Name: '', ObjectPathId: 26 },
    { Id: 29, ActionType: 1, Name: '', ObjectPathId: 28 },
    { Id: 30, ActionType: 4, Name: 'Style', ObjectPathId: 28, ArgumentInfo: { Arguments: [style] } },
    { Id: 31, ActionType: 2, Name: '', ObjectPathId: 28, QueryInfo: {} },
    { Id: 33, ActionType: 1, Name: '', ObjectPathId: 32 },
    {
      Id: 34,
      ActionType: 3,
      Name: 'Activate',
      ObjectPathId: 32,
      ArgumentInfo: { Arguments: [] },
      L: [1, 18, 21, 26, 28, 32],
    },
  ],
  ObjectPaths: {
    1: { Id: 1, ObjectPathType: 1, Name: '' },
    18: { Id: 18, ObjectPathType: 4, Name: 'DataConnections', ParentObjectPathId: 1 },
    21: {
      Id: 21,
      ObjectPathType: 3,
      Name: 'Add',
      ParentObjectPathId: 18,
      ArgumentInfo: { Arguments: [name, powerBiConnectionString(datasetId), dax, DAX_COMMAND_TYPE] },
    },
    23: { Id: 23, ObjectPathType: 4, Name: 'Application', ParentObjectPathId: 1 },
    26: { Id: 26, ObjectPathType: 4, Name: 'Tables', ParentObjectPathId: 1 },
    28: {
      Id: 28,
      ObjectPathType: 3,
      Name: 'AddQueryTable',
      ParentObjectPathId: 26,
      // The first argument is a reference to object path 21, not a literal —
      // which is what ReferencedObjectPathIds declares.
      ArgumentInfo: { Arguments: [21, anchor], ReferencedObjectPathIds: [21, 0] },
    },
    32: { Id: 32, ObjectPathType: 4, Name: 'Worksheet', ParentObjectPathId: 28 },
  },
});

export const insertPowerbiTable = defineTool({
  name: 'insert_powerbi_table',
  displayName: 'Insert Power BI Table',
  description:
    'Insert the result of a DAX query against a Power BI semantic model as a native Excel table, bound to a live connection so it can be refreshed. ' +
    'This is what Excel\'s own Data > Get Data from Power BI > "Insert Table" does, and unlike pasting values from the powerbi plugin\'s execute_dax the result stays connected to the model rather than going stale. ' +
    'Get dataset_id from powerbi list_datasets, or from inspect_data_model for a model this workbook already connects to. Write dax as a complete query starting with EVALUATE. ' +
    "CREATES A WORKBOOK CONNECTION, WHICH CANNOT BE DELETED from Excel for the web or any API — only the Excel desktop app can remove one, and a repeat call adds another rather than reusing it. Get the query right before calling: verify it with the powerbi plugin's execute_dax first.",
  summary: 'Insert a DAX query result as a live, refreshable table',
  icon: 'table',
  group: 'Data Model',
  input: z.object({
    dataset_id: z.string().describe('Power BI semantic model ID (a GUID), from list_datasets or inspect_data_model'),
    dax: z
      .string()
      .describe(
        'Complete DAX query, e.g. EVALUATE ROW("Sales", [CMTD Sales]) or EVALUATE TOPN(100, \'Store\'). Verify it with execute_dax before inserting.',
      ),
    worksheet: z.string().describe('Worksheet to place the table on. Prefer a new, empty sheet.'),
    anchor: z
      .string()
      .optional()
      .describe(
        'Top-left cell of the table in A1 notation. Defaults to A1. Existing content at the destination is overwritten.',
      ),
    connection_name: z
      .string()
      .optional()
      .describe(
        'Name for the workbook connection. Defaults to a name derived from the worksheet. Reusing an existing name does not reuse the connection — Excel appends a numeral.',
      ),
    table_style: z.string().optional().describe('Excel table style name. Defaults to TableStyleMedium7.'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const anchor = params.anchor ?? 'A1';
    const name = params.connection_name ?? `PowerBI_${params.worksheet.replace(/[^A-Za-z0-9]/g, '')}`;
    return ewaBridge(
      'ExecuteRichApiRequest',
      richApiRequest(
        params.worksheet,
        anchor,
        insertQueryTableBatch(name, params.dataset_id, params.dax, anchor, params.table_style ?? DEFAULT_TABLE_STYLE),
      ),
      { errorHints: EWA_ERROR_HINTS },
    );
  },
});
