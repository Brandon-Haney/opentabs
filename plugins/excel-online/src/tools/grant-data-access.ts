import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { EWA_ERROR_HINTS, bridgeOutputSchema, ewaBridge, viewportSelection } from '../bridge.js';
import { readConnections } from '../pivot-model.js';
import { fetchWorkbookPackage } from '../workbook-package.js';

/**
 * Data sources this tool is willing to authorise: Power BI semantic models.
 *
 * The prompt being answered asks whether an external data source can be
 * trusted, and the case it exists for is a workbook of unknown provenance whose
 * connection string points somewhere hostile. Restricting the grant to Power BI
 * endpoints keeps it to sources reached through the user's own tenant and their
 * own permissions, and makes the tool refuse — loudly, naming the connection —
 * exactly where a human ought to be the one answering.
 */
const POWER_BI_DATA_SOURCE = /^(?:pbiazure|powerbi):\/\//i;

/**
 * `MessageId` of Excel's "Query and Refresh Data" prompt.
 *
 * A constant the client holds rather than a value the server issues — it is
 * hardcoded in Excel's own bundle and appears unchanged across sessions, and it
 * is *not* the `MessageId` a `PftTokenMissing` error carries (`-198950119`), so
 * it cannot be read off a failure.
 */
const QUERY_AND_REFRESH_CONFIRMATION = 1243883867;

/**
 * Answer Excel's external-data trust prompt for the session.
 *
 * Every pivot operation over an external model — reading a filter's members,
 * setting one, placing a field, and creating the PivotTable itself — is refused
 * with `PftTokenMissing` until the workbook has been allowed to query its
 * external data. Excel asks with the "Query and Refresh Data" dialog and records
 * the answer as this single call; the payload is taken from a capture of the
 * dialog being answered by hand.
 *
 * The three context fields are the reason an earlier attempt at this failed and
 * was recorded as impossible. The four option fields matched the capture exactly,
 * but the reused donor context carries 18 keys where the client sends 21, and
 * the call is inert without the missing three.
 *
 * Kept as its own tool rather than folded into the pivot tools, so that granting
 * external-data trust is always a deliberate, separately-permissioned act and can
 * never happen as a side effect of asking for a filter's members.
 */
export const grantDataAccess = defineTool({
  name: 'grant_data_access',
  displayName: 'Allow External Data Queries',
  description:
    'Answer Excel\'s "Query and Refresh Data" trust prompt on the user\'s behalf, allowing this workbook to query its external data (Power BI models and other connections) for the rest of the browser session. ' +
    'ASK THE USER FIRST. The prompt this answers asks whether an external data source is trustworthy, and this tool answers Yes for them without showing it. ' +
    'Use it when a pivot operation fails with PftTokenMissing, or before creating the first PivotTable over a Power BI model in a workbook that has none — in that case there is no PivotTable filter for the user to open, so there is no way for them to grant it by hand. ' +
    "Refuses when any of the workbook's connections is not a Power BI semantic model, since those are the sources the prompt exists to guard; the user must answer those themselves. " +
    'The grant lasts until the page reloads, and a reload discards it.',
  summary: "Answer Excel's external-data trust prompt for this session",
  icon: 'shield-check',
  group: 'Data Model',
  input: z.object({
    worksheet: z
      .string()
      .describe('Any worksheet in the workbook — the call is scoped to a selection, and this names the sheet it uses.'),
    cell: z
      .string()
      .optional()
      .describe('Cell on that worksheet to scope the call to, in A1 notation. Defaults to A1.'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    // Checked before granting, not after: the grant covers every connection in
    // the workbook at once, so one source this tool should not vouch for is
    // enough to make the whole call the user's to answer rather than ours.
    const connections = await readConnections(await fetchWorkbookPackage());
    const unvouched = connections.filter(
      connection => connection.isRemoteModel !== false && !POWER_BI_DATA_SOURCE.test(connection.dataSource),
    );
    if (unvouched.length > 0) {
      const listed = unvouched.map(c => `"${c.name}" (${c.dataSource || 'no data source'})`).join(', ');
      throw ToolError.validation(
        `Refusing to grant external-data access: ${unvouched.length} of this workbook's ${connections.length} connections are not Power BI semantic models — ${listed}. ` +
          "This tool only vouches for Power BI sources, which are reached through the signed-in user's own tenant and permissions. " +
          'Excel\'s "Query and Refresh Data" prompt exists to guard exactly this case, so the user has to answer it themselves: ask them to open a PivotTable page-filter dropdown in Excel and answer Yes.',
      );
    }

    const cell = params.cell ?? 'A1';
    return ewaBridge(
      'SetParameters',
      {
        parameters: [],
        setParametersAtOpen: true,
        confirmation: QUERY_AND_REFRESH_CONFIRMATION,
        confirmationChoice: true,
      },
      {
        // The client also sends `BlockingUIOperation` and its timestamp here,
        // and both are deliberately left out: replaying them makes the server
        // reject the call outright as `InvalidEditSessionDuringShutDown`, on a
        // session that a `GetSessionStatus` probe answers normally either side
        // of the attempt. They describe the client's own modal state, which a
        // replay has no business asserting.
        contextPatch: viewportSelection(params.worksheet, cell),
        errorHints: EWA_ERROR_HINTS,
      },
    );
  },
});
