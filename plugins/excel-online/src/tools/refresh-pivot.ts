import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { AAD_TOKEN_GLOBAL, bridgeOutputSchema, ewaBridge } from '../bridge.js';

/**
 * Re-query the model behind a workbook connection.
 *
 * The Microsoft Graph workbook API cannot refresh an external data connection at
 * any version, so this goes through Excel's internal service via the frame
 * bridge. The `Refresh` method additionally requires `userAadToken`, the
 * per-session credential the server needs to reach the model on the user's
 * behalf. Excel mints that token inside its own document frame and sends it on
 * no other call, so the bridge reads it straight from a frame global rather than
 * routing it through the adapter — see `optionsFromFrameGlobals`.
 */
export const refreshPivot = defineTool({
  name: 'refresh_pivot',
  displayName: 'Refresh Connection',
  description:
    'Refresh a workbook data connection, re-querying the external model behind every PivotTable that uses it. ' +
    'Pass the connection name exactly as inspect_data_model or list_pivot_tables reports it (e.g. the "connection_name" of a pivot). ' +
    'PivotTable values are otherwise frozen at whatever the last refresh produced — they do not update when the underlying model changes, and nothing in the workbook flags them as stale, so a scorecard can report last month\'s numbers indefinitely. Check "last_refreshed" on list_pivot_tables to see how old the data is. ' +
    'This is deliberately never automatic: a refresh writes to the workbook and can trigger a coauthoring merge, so it is not something to run implicitly behind a read. ' +
    'Refreshing changes the values GETPIVOTDATA formulas return; that is the point, but it means downstream numbers move. ' +
    'Requires the workbook open in the browser, plus whatever permission the model itself demands.',
  summary: 'Refresh a workbook data connection',
  icon: 'refresh-cw',
  group: 'Data Model',
  input: z.object({
    connection_name: z
      .string()
      .min(1)
      .describe('Connection name as reported by inspect_data_model or list_pivot_tables (e.g. "SalesModel")'),
    external_source_index: z
      .number()
      .int()
      .optional()
      .describe(
        'Index of the external source within the connection. Defaults to 1, which is correct for a single-source connection.',
      ),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge(
      'Refresh',
      {
        connectionName: params.connection_name,
        externalSourceIndex: params.external_source_index ?? 1,
      },
      // The credential is read inside the Office frame and merged into the
      // request there, so it never reaches this adapter or the tool result.
      { optionsFromFrameGlobals: { userAadToken: AAD_TOKEN_GLOBAL } },
    ),
});
