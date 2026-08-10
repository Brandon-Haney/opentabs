import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { buildRangeAddress } from '../a1.js';
import {
  type BridgeProjection,
  EWA_ERROR_HINTS,
  EWA_GET_CONTEXT_KEYS,
  bridgeOutputSchema,
  ewaBridgeRead,
  viewportSelection,
} from '../bridge.js';
import { pageFilterCell, readConnections, readPivotCaches, readPivotTables, toFilterFieldId } from '../pivot-model.js';
import { fetchWorkbookPackage } from '../workbook-package.js';
import { PIVOT_DATA_SOURCE_INDEX } from './pivot-data-source.js';

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
 * What the probe returns: the filter's root node, name only.
 *
 * Deliberately not {@link MEMBER_PROJECTION}, which flattens the tree — a store
 * or product dimension answers with thousands of members, and this tool's result
 * is a yes/no about the grant, not a member list. Whether the service answered
 * at all is the entire signal, so one node is as good as all of them.
 */
const PROBE_PROJECTION: BridgeProjection = {
  path: 'Result.PivotFilterItemsList.PivotFilterItems',
  fields: { name: 'DisplayString' },
};

/** The four option fields the client sends when the user answers Yes. */
const CONFIRMATION_OPTIONS = {
  parameters: [],
  setParametersAtOpen: true,
  confirmation: QUERY_AND_REFRESH_CONFIRMATION,
  confirmationChoice: true,
};

/**
 * A gated operation replayed straight after the grant, to establish whether the
 * grant actually took effect.
 *
 * The service answers a `SetParameters` that changed nothing exactly as it
 * answers one that granted the workbook — HTTP 200, no errors — so the response
 * to the grant carries no signal at all. Only attempting something the gate
 * blocks distinguishes the two.
 */
interface ConsentProbe {
  method: string;
  options: Record<string, unknown>;
  httpMethod?: 'GET';
  contextKeys?: string[];
  projection?: BridgeProjection;
  /** Sheet and cell the grant's viewport is pointed at, mirroring the client. */
  viewport?: { worksheet: string; address: string };
}

/**
 * Choose the cheapest operation that proves the gate opened.
 *
 * A page filter is preferred because reading one changes nothing. Only a
 * workbook with no page filter anywhere falls back to a refresh, which is the
 * one other gated operation available without a filter and does write.
 *
 * The probe's `dataSourceIndex` does not have to be the right one for its pivot:
 * a wrong index still gets an answer rather than a refusal (it returns the "All"
 * row alone), and answered-versus-refused is the entire question here.
 */
const chooseProbe = async (): Promise<ConsentProbe> => {
  const pkg = await fetchWorkbookPackage();
  const caches = await readPivotCaches(pkg, await readConnections(pkg));

  for (const table of await readPivotTables(pkg, caches)) {
    const filter = table.filters[0];
    const cell = filter ? pageFilterCell(table, 0) : null;
    if (!filter || !cell) continue;
    const address = buildRangeAddress({
      startRow: cell.row,
      startCol: cell.column,
      endRow: cell.row,
      endCol: cell.column,
    });
    return {
      method: 'GetPivotFilterData',
      httpMethod: 'GET',
      contextKeys: EWA_GET_CONTEXT_KEYS,
      projection: PROBE_PROJECTION,
      viewport: { worksheet: table.worksheet, address },
      options: {
        cell: {
          SheetName: table.worksheet,
          NamedObjectName: '',
          FirstRow: cell.row,
          FirstColumn: cell.column,
        },
        dataSourceIndex: PIVOT_DATA_SOURCE_INDEX,
        optionalPivotAnchorParameter: { AnchorType: 0, ChartId: null, AnchorValue1: -1, AnchorValue2: -1 },
        fieldId: toFilterFieldId(filter.fieldIndex),
        parentId: -1,
        needConnect: true,
      },
    };
  }

  return { method: 'RefreshAllNew', options: { periodic: false, refreshOnOpen: false } };
};

/**
 * Answer Excel's external-data trust prompt, and prove it worked.
 *
 * Every operation over an external model — reading a filter's members, setting
 * one, placing a field, creating the PivotTable, and refreshing a connection —
 * is refused with `PftTokenMissing` until the workbook has been allowed to query
 * its external data. Excel asks with the "Query and Refresh Data" dialog and
 * records the answer as this single call; the payload comes from a capture of
 * the dialog being answered by hand.
 *
 * The two `BlockingUIOperation` fields are why an earlier attempt at this was
 * recorded as impossible. The four option fields matched the capture exactly and
 * the call still granted nothing, because the client sends 21 context keys where
 * a donor-lifted context has 19. Including them from the donor was tried and
 * rejected as `InvalidEditSessionDuringShutDown`, which read as "this cannot be
 * replayed" — but the donor's timestamp is from a modal that has long since
 * closed. Minted fresh at replay time, the same two fields are accepted.
 *
 * Kept as its own tool rather than folded into the pivot tools, so that granting
 * external-data trust is always a deliberate, separately-permissioned act and can
 * never happen as a side effect of asking for a filter's members.
 */
export const grantDataAccess = defineTool({
  name: 'grant_data_access',
  displayName: 'Allow External Data Queries',
  description:
    'Allow this workbook to query its external Power BI data, answering Excel\'s "Query and Refresh Data" trust prompt without showing it. ' +
    'Every PivotTable operation over a Power BI model — reading or setting a filter, placing a field, creating the pivot, and refreshing a connection — is refused with PftTokenMissing until this is granted. ' +
    'One grant covers every connection in the workbook and survives page reloads, so it is needed at most once per workbook per browser session. ' +
    'This VERIFIES rather than assumes: the service answers a grant that changed nothing exactly as it answers one that worked, so the tool immediately attempts a gated operation and reports that result. An empty "errors" therefore means the grant demonstrably took effect; PftTokenMissing means it did not, and retrying unchanged will fail identically. ' +
    'Refuses when any connection is not a Power BI semantic model, since those are the sources the prompt exists to guard.',
  summary: "Answer Excel's external-data trust prompt and verify it took effect",
  icon: 'shield-check',
  group: 'Data Model',
  input: z.object({
    worksheet: z
      .string()
      .optional()
      .describe(
        'Only needed when the workbook has no PivotTable page filter to point the grant at. Names any worksheet; the call is scoped to a selection on it.',
      ),
  }),
  output: bridgeOutputSchema.extend({
    response: z
      .unknown()
      .describe(
        'Whatever the probe answered — its content does not matter and is deliberately trimmed to almost nothing. ' +
          'That it answered at all, with an empty "errors", is the proof the grant took effect.',
      ),
  }),
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

    const probe = await chooseProbe();
    const viewport = probe.viewport ?? (params.worksheet ? { worksheet: params.worksheet, address: 'A1' } : null);
    if (!viewport) {
      throw ToolError.validation(
        'This workbook has no PivotTable page filter to scope the grant to, so pass "worksheet" naming any worksheet in it.',
      );
    }

    return ewaBridgeRead(probe.method, probe.options, {
      // The grant runs first and the probe second, in one atomic bridge call, so
      // the two cannot be separated and the result always describes the grant
      // that was just made rather than a grant made at some earlier point.
      prep: { method: 'SetParameters', options: CONFIRMATION_OPTIONS },
      // Patched into the context both replays share. The filter probe is a GET
      // restricted to EWA_GET_CONTEXT_KEYS, so it drops these three; the refresh
      // fallback is a POST and carries them, which is untested — the timestamp is
      // fresh either way, and staleness was what the server objected to.
      contextPatch: {
        // TopLeft included here and nowhere else: this is the one call whose
        // captured context carries it.
        ...viewportSelection(viewport.worksheet, viewport.address, 'A1'),
        // The client raises the prompt as a blocking modal and stamps the moment
        // it did. Generated here rather than replayed from the donor, whose
        // stamp belongs to a modal that has since closed — a stale one is
        // rejected outright as InvalidEditSessionDuringShutDown.
        BlockingUIOperation: true,
        BlockingUIOperationTimestamp: String(Date.now()),
      },
      ...(probe.httpMethod ? { httpMethod: probe.httpMethod } : {}),
      ...(probe.contextKeys ? { contextKeys: probe.contextKeys } : {}),
      ...(probe.projection ? { projection: probe.projection } : {}),
      errorHints: EWA_ERROR_HINTS,
    });
  },
});
