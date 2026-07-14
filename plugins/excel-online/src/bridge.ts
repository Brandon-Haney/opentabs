import { z } from 'zod';
import { type RangeBounds, buildRangeAddress, parseBoundedRange } from './a1.js';

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
    contextPatch?: Record<string, unknown>;
  };
}

/**
 * An optional get-state call for stateful "dialog" methods (data validation,
 * conditional formatting). The engine replays it before the commit and merges
 * its fresh edit-state into the reused context.
 */
export interface EwaPrep {
  method: string;
  options?: Record<string, unknown>;
}

/** Advanced bridge behaviors for stateful methods. */
export interface EwaBridgeExtra {
  /** A get-state prep call to run before the commit (see {@link EwaPrep}). */
  prep?: EwaPrep;
  /** Top-level context fields to patch in before replaying (e.g. {@link viewportSelection}). */
  contextPatch?: Record<string, unknown>;
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
        ? { prepMethod: extra.prep.method, ...(extra.prep.options ? { prepOptions: extra.prep.options } : {}) }
        : {}),
      ...(extra?.contextPatch ? { contextPatch: extra.contextPatch } : {}),
    },
  };
  return directive as unknown as z.infer<typeof bridgeOutputSchema>;
};

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
