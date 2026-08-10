import { z } from 'zod';
import { buildRangeAddress, parseBoundedRange, type RangeBounds } from './a1.js';

/**
 * The Excel Online formatting/layout features Microsoft Graph does not expose
 * are driven through Excel's internal JSON-RPC, `EwaInternalWebService`, hosted
 * inside the cross-origin Office Web Apps document frame. A plugin tool cannot
 * call that API directly — the adapter runs in the SharePoint host frame, and
 * the endpoint sends no CORS headers. Instead a tool builds the RPC method and
 * options from friendly inputs and returns a `__bridge` directive; the platform
 * runs the harvest-and-replay engine (`browser.frameBridgeRpc`) on the same tab,
 * reusing a live session `context` a document_start pre-script interceptor
 * stashes in the frame, and returns the parsed `EwaResult`.
 */

/** Substring identifying the Office Web Apps document frame the RPC is replayed in. */
const FRAME_URL_INCLUDES = 'xlviewerinternal.aspx';
/** Substring identifying donor requests that carry the live session `context`. */
const HARVEST_URL_INCLUDES = 'EwaInternalWebService.json/';
/** Frame global the pre-script interceptor stashes the freshest donor into. */
const DONOR_GLOBAL = '__otbEwaDonor';

/**
 * Parsed `EwaResult` the platform returns after running the bridge. This is what
 * the agent receives — not the `__bridge` directive the handler returns, which
 * the platform intercepts and replaces. `errors` empty means the RPC succeeded.
 */
export const bridgeOutputSchema = z.object({
  ok: z.boolean().describe('Whether the RPC replay succeeded at the HTTP level.'),
  status: z.number().int().describe('HTTP status of the replayed request.'),
  errors: z
    .array(z.unknown())
    .describe('Parsed EwaResult.Errors — an empty array means the operation was applied successfully.'),
});

/**
 * Output shape for bridge calls whose payload is the point.
 *
 * A write only needs to report that it applied, so {@link bridgeOutputSchema}
 * suffices; a read has to hand back what the service returned. The body is
 * declared as an open object rather than a modelled one because `EwaResult`
 * carries a large, method-specific `Result` whose shape differs per call — each
 * reading tool documents the fields worth looking at in its own description.
 */
export const bridgeReadOutputSchema = bridgeOutputSchema.extend({
  response: z.record(z.string(), z.unknown()).describe('The raw EwaResult returned by the service.'),
});

/** Frame global the pre-script stashes the freshest per-session AAD token into. */
export const AAD_TOKEN_GLOBAL = '__otbEwaAadToken';

/**
 * What to tell an agent whose pivot operation was refused with `PftTokenMissing`.
 *
 * Established by capturing a full session's RPC stream: there are two gates, not
 * one. Excel's "Query and Refresh Data" dialog is raised at most once per browser
 * session, and the grant it unlocks is applied **per data source**, as the app
 * itself touches each one. A workbook drawing on two models therefore needs the
 * prompt answered once and a filter opened on a pivot over each model — answering
 * the prompt on one pivot leaves the other still refused.
 */
const PIVOT_CONSENT_HINT =
  "This PivotTable's data source has not been allowed to be queried in this browser session. " +
  'Ask the user to open a page-filter dropdown on this specific PivotTable in Excel, answering Yes to the ' +
  '"Query and Refresh Data" prompt if it appears. The prompt appears at most once per session, but every data ' +
  'source still needs a filter opened on one of its own pivots — granting it for one model does not cover another. ' +
  'Do not reload the page: a reload revokes every grant. No tool can grant this, and retrying without that ' +
  'interaction fails identically.';

/**
 * Guidance attached to a failed bridge call, keyed by the service's error code.
 *
 * The engine reports the code and the service's own message; these say what to do
 * about it, which is knowledge about Excel rather than about the bridge.
 */
export const EWA_ERROR_HINTS: Record<string, string> = {
  PftTokenMissing: PIVOT_CONSENT_HINT,
  RetryOutOfSync:
    'This service reports every malformed argument as RetryOutOfSync, so a wrong argument is far more likely than ' +
    'a stale session. Re-read the pivot layout and check each argument rather than retrying unchanged.',
};

/**
 * Context keys a GET method on this service carries.
 *
 * GET requests put the context in the query string, and a harvested donor
 * context varies by call site — a `Refresh` donor carries an ~88 KB flight blob
 * that no GET needs and that would overflow a practical URL. This is the exact
 * key set observed on live GET traffic; every one also exists in a POST context,
 * so the donor always supplies them.
 */
export const EWA_GET_CONTEXT_KEYS = [
  'WorkbookMetadataParameter',
  'ClientRequestId',
  'InstantaneousType',
  'MakeInstantaneousChange',
  'SessionId',
  'TransientEditSessionToken',
  'PermissionFlags',
  'Configurations',
  'CompleteResponseTimeout',
  'IsWindowHidden',
  'IsWindowVisible',
  'CollaborationParameter',
  'MachineCluster',
  'AjaxOptions',
  'ReturnSheetProcessedData',
  'HasAnyNonOcsCoauthor',
  'MergeCount',
  'ClientRevisions',
];

/**
 * The cell reference shape the pivot methods take: a single cell inside the
 * PivotTable, zero-based, unlike the one-based coordinates the filter methods
 * use elsewhere in this service.
 */
export const pivotCellRef = (worksheet: string, address: string): Record<string, unknown> => {
  const bounds = parseBoundedRange(address);
  return {
    SheetName: worksheet,
    NamedObjectName: '',
    FirstRow: bounds.startRow,
    FirstColumn: bounds.startCol,
  };
};

/**
 * Identity the Office object-model endpoint expects on a `ProcessQuery` call.
 *
 * These are the values Excel's own Power BI task pane sends. The endpoint
 * requires a caller identity and rejects the request without one; they carry no
 * privilege of their own, since the request is already authorised by the
 * session it replays inside.
 */
const RICH_API_CALLER = {
  AppPermission: 135,
  RequestFlags: 17,
  InstanceId: '{55822971-FC63-4903-A409-046E4EE07D0C}.PowerBi.Url',
  CompliantSolutionId: 'FA000000054',
  SolutionId: 'FA000000054',
  MarketplaceType: 'sdxcatalog',
  SolutionVersion: '0.0.0.0',
  StoreLocation: 'sdxcatalog',
};

/**
 * Wrap an Office object-model batch in the envelope `ExecuteRichApiRequest`
 * expects.
 *
 * `worksheet` and `cell` set the request's active selection, which is how the
 * batch's `GetActiveWorksheet` resolves — this object model exposes no lookup of
 * a worksheet by name, so the envelope is the only way to target one.
 */
export const richApiRequest = (
  worksheet: string,
  cell: string,
  batch: Record<string, unknown>,
): Record<string, unknown> => {
  const bounds = parseBoundedRange(cell);
  const selection = {
    SheetName: worksheet,
    NamedObjectName: '',
    FirstRow: bounds.startRow,
    LastRow: bounds.startRow,
    FirstColumn: bounds.startCol,
    LastColumn: bounds.startCol,
  };
  return {
    request: {
      HttpMethod: 'POST',
      PathAndQuery: 'ProcessQuery',
      RequestHeaders: [{ Name: 'SdkVersion', Value: 'officejs' }],
      RequestBody: JSON.stringify(batch),
      ...RICH_API_CALLER,
      SheetMultiRange: { SheetName: worksheet, NamedObjectName: '', Ranges: [selection] },
      ActiveCell: selection,
      ActiveFloatingObjectId: null,
      SelectionState: 2,
      IsEventsEnabled: true,
      RequestGuid: crypto.randomUUID(),
    },
  };
};

/**
 * The same cell reference with explicit `Last*` bounds and a null object name —
 * the shape the field-placement method expects, which differs from the read
 * methods' by those three fields alone.
 */
export const pivotCellBounds = (worksheet: string, address: string): Record<string, unknown> => {
  const bounds = parseBoundedRange(address);
  return {
    SheetName: worksheet,
    NamedObjectName: null,
    FirstRow: bounds.startRow,
    FirstColumn: bounds.startCol,
    LastRow: bounds.startRow,
    LastColumn: bounds.startCol,
  };
};

/** The directive shape an adapter tool returns to invoke the frame-bridge engine. */
interface BridgeDirective {
  __bridge: {
    method: string;
    options: Record<string, unknown>;
    frameUrlIncludes: string;
    harvestUrlIncludes: string;
    donorGlobal: string;
    prepMethod?: string;
    prepOptions?: Record<string, unknown>;
    prepMergesContext?: boolean;
    optionsFromPrep?: EwaPrepSelection[];
    contextPatch?: Record<string, unknown>;
    optionsFromFrameGlobals?: Record<string, string>;
    projection?: BridgeProjection;
    errorHints?: Record<string, string>;
  };
}

/**
 * Selects and reshapes part of a response before it reaches the agent.
 *
 * A tool cannot do this itself: the handler returns a directive and the platform
 * performs the call, so the response never passes through the handler. The
 * service wraps its payload in a large envelope and nests it as a tree with many
 * fields per node, so an unprojected read of a large dimension ships megabytes
 * of boilerplate to the caller.
 */
export interface BridgeProjection {
  /** Dot path to the value to return; a numeric segment indexes an array. */
  path: string;
  /** Output key → source key. Omit to return matched values unchanged. */
  fields?: Record<string, string>;
  /** Key holding a node's children; set it to flatten the tree into one list. */
  flattenChildren?: string;
}

/**
 * An optional get-state call for stateful "dialog" methods (data validation,
 * conditional formatting). The engine replays it before the commit and merges
 * its fresh edit-state into the reused context.
 */
export interface EwaPrep {
  method: string;
  options?: Record<string, unknown>;
  /**
   * Whether the prep response's edit-state is folded into the context before the
   * commit. Defaults to true, which is what a get-state dialog method needs.
   * Set false for a prep that only looks something up.
   */
  mergesContext?: boolean;
}

/**
 * Resolve a commit option from the prep call's response.
 *
 * For an id the caller cannot know and must not guess: the prep call looks the
 * name up and the engine feeds the resulting ids into the commit, all inside the
 * frame, because a tool handler never sees a bridge response. A term matching
 * nothing or more than one candidate fails the call rather than choosing.
 */
export interface EwaPrepSelection {
  /** Commit option to populate. */
  option: string;
  /** How to flatten the prep response before matching. */
  projection: BridgeProjection;
  /** Projected field the terms are matched against, case-insensitively and by substring. */
  matchField: string;
  /** Projected field collected from each matched node. */
  valueField: string;
  /** Terms to resolve; each must identify exactly one node. */
  values: string[];
  /** Collect as strings — some methods want their ids quoted. */
  asString?: boolean;
}

/** Advanced bridge behaviors for stateful methods. */
export interface EwaBridgeExtra {
  /** A get-state prep call to run before the commit (see {@link EwaPrep}). */
  prep?: EwaPrep;
  /** Options resolved from the prep call's response (see {@link EwaPrepSelection}). */
  prepSelections?: EwaPrepSelection[];
  /** Top-level context fields to patch in before replaying (e.g. {@link viewportSelection}). */
  contextPatch?: Record<string, unknown>;
  /**
   * Option values sourced from frame globals rather than from the adapter, as
   * `{ optionName: frameGlobalName }`. The engine reads them inside the Office
   * frame, so a credential named here never crosses into the adapter.
   */
  optionsFromFrameGlobals?: Record<string, string>;
  /** HTTP verb for the call; defaults to POST. Reads on this service are GETs. */
  httpMethod?: 'GET' | 'POST';
  /** Restrict the reused context to these keys — required for GET, where it travels in the URL. */
  contextKeys?: string[];
  /** Reshape the response before the agent sees it (see {@link BridgeProjection}). */
  projection?: BridgeProjection;
  /**
   * Service error code → guidance appended when the call fails with that code
   * (see {@link EWA_ERROR_HINTS}). The platform raises a failed call as an error
   * rather than a result, so this is the tool's only chance to say what to do
   * about it — the handler never sees the response.
   */
  errorHints?: Record<string, string>;
}

/**
 * Build the `__bridge` directive for an `EwaInternalWebService` method call.
 *
 * The return is typed as the bridge output schema, not the directive, because
 * the platform replaces the directive with the engine's parsed `EwaResult`
 * before the agent sees it — a platform-level transform the type system cannot
 * otherwise express. The cast is localized here so the bridge tools stay fully
 * typed against what the agent actually receives.
 */
export const ewaBridge = (
  method: string,
  options: Record<string, unknown>,
  extra?: EwaBridgeExtra,
): z.infer<typeof bridgeOutputSchema> => {
  const directive: BridgeDirective = {
    __bridge: {
      method,
      options,
      frameUrlIncludes: FRAME_URL_INCLUDES,
      harvestUrlIncludes: HARVEST_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      ...(extra?.prep
        ? {
            prepMethod: extra.prep.method,
            ...(extra.prep.options ? { prepOptions: extra.prep.options } : {}),
            ...(extra.prep.mergesContext === false ? { prepMergesContext: false } : {}),
          }
        : {}),
      ...(extra?.prepSelections ? { optionsFromPrep: extra.prepSelections } : {}),
      ...(extra?.contextPatch ? { contextPatch: extra.contextPatch } : {}),
      ...(extra?.optionsFromFrameGlobals ? { optionsFromFrameGlobals: extra.optionsFromFrameGlobals } : {}),
      ...(extra?.httpMethod ? { httpMethod: extra.httpMethod } : {}),
      ...(extra?.contextKeys ? { contextKeys: extra.contextKeys } : {}),
      ...(extra?.projection ? { projection: extra.projection } : {}),
      ...(extra?.errorHints ? { errorHints: extra.errorHints } : {}),
    },
  };
  return directive as unknown as z.infer<typeof bridgeOutputSchema>;
};

/**
 * {@link ewaBridge} for a reading method, typed to include the service's
 * response body. The engine returns the same object either way — this only
 * widens the declared type for tools whose output is the payload.
 *
 * Parameterised on the response shape so a tool that passes a `projection` can
 * declare what the projection produces, rather than the raw envelope it
 * replaces.
 */
export const ewaBridgeRead = <Response = Record<string, unknown>>(
  method: string,
  options: Record<string, unknown>,
  extra?: EwaBridgeExtra,
): z.infer<typeof bridgeOutputSchema> & { response: Response } =>
  ewaBridge(method, options, extra) as unknown as z.infer<typeof bridgeOutputSchema> & { response: Response };

/** A zero-based inclusive cell rectangle in the shape EwaInternalWebService expects. */
export interface EwaRange {
  FirstRow: number;
  FirstColumn: number;
  LastRow: number;
  LastColumn: number;
}

/** Convert internal {@link RangeBounds} to the EWA `{FirstRow,FirstColumn,LastRow,LastColumn}` shape. */
export const boundsToEwaRange = (bounds: RangeBounds): EwaRange => ({
  FirstRow: bounds.startRow,
  FirstColumn: bounds.startCol,
  LastRow: bounds.endRow,
  LastColumn: bounds.endCol,
});

/** Parse an A1 range address into the EWA range shape (0-based inclusive). */
export const addressToEwaRange = (address: string): EwaRange => boundsToEwaRange(parseBoundedRange(address));

/**
 * The `selectedRanges`/`anchor` wrapper every range-scoped EWA method expects:
 * a sheet name plus a list of 0-based ranges (verified from live captures — the
 * ranges are NOT a bare array, they are nested under this object).
 */
export interface EwaSelectedRanges {
  SheetName: string;
  NamedObjectName: string;
  Ranges: EwaRange[];
}

/** Build the `selectedRanges`/`anchor` wrapper for one or more A1 range addresses. */
export const selectedRanges = (worksheet: string, ...addresses: string[]): EwaSelectedRanges => ({
  SheetName: worksheet,
  NamedObjectName: '',
  Ranges: addresses.map(addressToEwaRange),
});

/**
 * Build a `ViewportStateChange` context patch describing the current selection.
 * Selection-scoped stateful methods (data validation, conditional formatting)
 * validate that the reused context's selection matches the operation's range —
 * a poll-sourced donor context lacks it, so the tool must supply it.
 */
export const viewportSelection = (worksheet: string, address: string): Record<string, unknown> => {
  const bounds = parseBoundedRange(address);
  const activeCell = buildRangeAddress({
    startRow: bounds.startRow,
    startCol: bounds.startCol,
    endRow: bounds.startRow,
    endCol: bounds.startCol,
  });
  return {
    ViewportStateChange: {
      SheetViewportStateChanges: [
        { SheetName: worksheet, SelectedRanges: selectedRanges(worksheet, address), ActiveCell: activeCell },
      ],
    },
  };
};
