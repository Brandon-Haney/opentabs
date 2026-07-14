import { fetchInFrame } from './frame-fetch.js';
import {
  requireStringParam,
  requireTabId,
  sendErrorResult,
  sendSuccessResult,
  sendValidationError,
} from './helpers.js';

/** Default frame global the pre-script interceptor writes the freshest donor into. */
const DEFAULT_DONOR_GLOBAL = '__otbEwaDonor';

/** How long to wait for a donor request to appear in the frame global. */
const HARVEST_TIMEOUT_MS = 30_000;
/** Poll interval while waiting for a donor request. */
const HARVEST_POLL_MS = 500;

/**
 * A request captured by the pre-script interceptor and stashed in the frame
 * global. Generic "captured request" shape — carries no app-specific knowledge.
 */
interface CapturedDonor {
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  ts: number;
}

/**
 * Request headers that a `fetch()` cannot set (the browser forbids or manages
 * them). They are stripped from the harvested set before replay; cookies flow
 * automatically via `credentials: 'include'`.
 */
const FORBIDDEN_REPLAY_HEADERS = new Set([
  'cookie',
  'host',
  'content-length',
  'origin',
  'referer',
  'connection',
  'accept-encoding',
  'user-agent',
  'dnt',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
]);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Strip headers a fetch cannot set, and refresh the correlation id. */
export const buildReplayHeaders = (harvested: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(harvested)) {
    if (FORBIDDEN_REPLAY_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  // A new correlation id per call keeps server-side telemetry/dedup honest.
  const correlationKey = Object.keys(headers).find(k => k.toLowerCase() === 'x-correlationid');
  if (correlationKey) headers[correlationKey] = crypto.randomUUID();
  return headers;
};

/**
 * Derive the target URL for `method` from a donor request URL, preserving the
 * origin, path prefix up to the RPC marker, and query string (e.g. waccluster).
 * Donor: `https://host/x/_vti_bin/Svc.json/GetSessionStatus?waccluster=PUS1`
 * → `https://host/x/_vti_bin/Svc.json/FreezeOrUnfreezePanes?waccluster=PUS1`.
 */
export const deriveTargetUrl = (donorUrl: string, marker: string, method: string): string => {
  const markerIdx = donorUrl.indexOf(marker);
  if (markerIdx === -1) throw new Error(`Donor URL does not contain marker "${marker}": ${donorUrl}`);
  const base = donorUrl.slice(0, markerIdx + marker.length);
  const queryIdx = donorUrl.indexOf('?');
  const query = queryIdx === -1 ? '' : donorUrl.slice(queryIdx);
  return `${base}${method}${query}`;
};

/**
 * Validate that a value read from the frame global is a well-formed donor.
 * Returns the typed donor, or null when the shape is wrong or absent.
 */
const asCapturedDonor = (value: unknown): CapturedDonor | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.url !== 'string' || typeof v.requestBody !== 'string' || typeof v.ts !== 'number') return null;
  if (typeof v.requestHeaders !== 'object' || v.requestHeaders === null) return null;
  return {
    url: v.url,
    requestBody: v.requestBody,
    requestHeaders: v.requestHeaders as Record<string, string>,
    ts: v.ts,
  };
};

/**
 * Read the donor global from the child frame whose URL contains
 * `frameUrlIncludes`. Runs in the frame's MAIN world (same realm the pre-script
 * interceptor wrote into). Returns the donor, or null when the frame is not yet
 * present or has not captured a request.
 */
const readDonorFromFrame = async (
  tabId: number,
  frameUrlIncludes: string,
  donorGlobal: string,
): Promise<CapturedDonor | null> => {
  const probe = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: (globalName: string) => ({
      href: location.href,
      donor: (globalThis as Record<string, unknown>)[globalName] ?? null,
    }),
    args: [donorGlobal],
  });
  const match = probe.find(frame => {
    const r = frame.result as { href?: string } | undefined;
    return typeof r?.href === 'string' && r.href.includes(frameUrlIncludes);
  });
  if (!match) return null;
  const donor = (match.result as { donor?: unknown } | undefined)?.donor;
  return asCapturedDonor(donor);
};

/** Parsed outcome of a frame-bridge RPC invocation. */
export interface FrameBridgeRpcResult {
  frameId: number;
  status: number;
  ok: boolean;
  /** Parsed `EwaResult.Errors` when the response is that shape (empty = success). */
  errors?: unknown[];
  response: unknown;
}

/** Parameters accepted by {@link runFrameBridgeRpc}. */
export interface FrameBridgeRpcParams {
  tabId: number;
  frameUrlIncludes: string;
  harvestUrlIncludes: string;
  method: string;
  options?: Record<string, unknown>;
  /** Frame global the pre-script interceptor wrote the donor into (default `__otbEwaDonor`). */
  donorGlobal?: string;
  /**
   * Optional get-state method to replay before `method` for stateful "dialog"
   * operations (e.g. `GetDataValidationSettings`). Its response refreshes the
   * live edit-state fields in the reused context so the commit is not rejected
   * as a stale coauth revision. Omit for stateless methods.
   */
  prepMethod?: string;
  /** Options for the prep call's request body (merged alongside `context`). */
  prepOptions?: Record<string, unknown>;
  /**
   * Top-level fields to patch into the reused `context` before replaying — e.g.
   * a `ViewportStateChange` selection that a selection-scoped stateful method
   * requires but a poll-sourced donor context lacks. Shallow-merged.
   */
  contextPatch?: Record<string, unknown>;
}

/** Error thrown by {@link runFrameBridgeRpc} when no valid donor is available. */
export class FrameBridgeValidationError extends Error {}

/** Parse an EwaResult response body into `{ response, errors, ewaResult }`. */
const parseEwaResult = (
  body: string,
): { response: unknown; errors?: unknown[]; ewaResult?: Record<string, unknown> } => {
  try {
    const parsed = JSON.parse(body) as { d?: Record<string, unknown> };
    const ewaResult = parsed.d;
    const errors = ewaResult && Array.isArray(ewaResult.Errors) ? (ewaResult.Errors as unknown[]) : undefined;
    return { response: ewaResult ?? parsed, errors, ewaResult };
  } catch {
    return { response: body };
  }
};

/** Read a nested property by key path, returning undefined if any segment is missing. */
const nested = (obj: unknown, ...keys: string[]): unknown => {
  let cur = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
};

/** Assign a leaf value into a nested path, but only when the parent objects already exist. */
const assignExisting = (root: Record<string, unknown>, value: unknown, ...path: string[]): void => {
  if (value === undefined) return;
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i] as string];
    if (!next || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = value;
};

/**
 * Merge the live edit-state fields of a fresh EwaResult response into a reused
 * request `context`, so a follow-up commit carries the server's current
 * revision. Only overwrites leaf values the response provides, and only where
 * the context already has the matching nested shape — the context is otherwise
 * left intact. Mutates `context` in place.
 */
export const mergeContextFromResponse = (context: Record<string, unknown>, r: Record<string, unknown>): void => {
  if (typeof r.SessionId === 'string') context.SessionId = r.SessionId;
  if (typeof r.TransientEditSessionToken === 'string') context.TransientEditSessionToken = r.TransientEditSessionToken;

  const metadataVersion = nested(r, 'WorkbookMetadataResult', 'WorkbookMetadataState', 'MetadataVersion');
  assignExisting(context, metadataVersion, 'WorkbookMetadataParameter', 'WorkbookMetadataState', 'MetadataVersion');

  const userListVersion = nested(r, 'CollaborationResult', 'CollaborationState', 'UserListVersion');
  assignExisting(context, userListVersion, 'CollaborationParameter', 'CollaborationState', 'UserListVersion');
  const collabStateId = nested(r, 'CollaborationResult', 'CollaborationState', 'CollabStateId');
  assignExisting(context, collabStateId, 'CollaborationParameter', 'CollaborationState', 'CollabStateId');

  // ClientRevisions tracks the block-cache revision, which equals the response StateId.
  if (typeof r.StateId === 'number' && r.StateId >= 0) {
    const rev = context.ClientRevisions;
    if (rev && typeof rev === 'object') {
      const cr = rev as Record<string, unknown>;
      if ('Min' in cr) cr.Min = r.StateId;
      if ('Max' in cr) cr.Max = r.StateId;
      if ('MaxFromBlockCache' in cr) cr.MaxFromBlockCache = r.StateId;
    }
  }

  if (
    r.MergeCount &&
    typeof r.MergeCount === 'object' &&
    context.MergeCount &&
    typeof context.MergeCount === 'object'
  ) {
    context.MergeCount = r.MergeCount;
  }
};

/**
 * Replay a single method inside the embedded frame using the reused `context`.
 * Refreshes `ClientRequestId` per call. Returns the parsed result plus the raw
 * EwaResult object (for state merging between a prep call and the commit).
 */
const replayMethod = async (
  tabId: number,
  frameUrlIncludes: string,
  harvestUrlIncludes: string,
  donor: CapturedDonor,
  method: string,
  context: Record<string, unknown>,
  options: Record<string, unknown>,
): Promise<{ result: FrameBridgeRpcResult; ewaResult?: Record<string, unknown> }> => {
  if ('ClientRequestId' in context) context.ClientRequestId = crypto.randomUUID();
  const headers = buildReplayHeaders(donor.requestHeaders);
  const targetUrl = deriveTargetUrl(donor.url, harvestUrlIncludes, method);
  const body = JSON.stringify({ context, ...options });
  const fr = await fetchInFrame(tabId, frameUrlIncludes, { url: targetUrl, method: 'POST', headers, body });
  const { response, errors, ewaResult } = parseEwaResult(fr.body);
  return { result: { frameId: fr.frameId, status: fr.status, ok: fr.ok, errors, response }, ewaResult };
};

/**
 * Harvest-and-replay bridge for coauth-context RPC APIs (e.g. the Office Web
 * Apps `EwaInternalWebService`). One atomic operation:
 *   1. read the freshest donor request the pre-script interceptor stashed in the
 *      embedded frame's `donorGlobal` (polling briefly for the frame to capture
 *      one) — reusing its auth headers and live session `context`;
 *   2. for a stateful method, replay `prepMethod` first and merge its fresh
 *      edit-state into the reused context;
 *   3. build `{ context, ...options }` with a fresh `ClientRequestId`, derive the
 *      target URL for `method` from the donor URL, and replay the POST inside the
 *      embedded frame (same-origin, cookies + tokens).
 *
 * Harvesting reads a frame global written by a `document_start` MAIN-world
 * interceptor — no debugger attachment and no tab reload.
 *
 * @throws {FrameBridgeValidationError} when no valid donor is captured in time
 *   or the donor is malformed.
 */
export const runFrameBridgeRpc = async (params: FrameBridgeRpcParams): Promise<FrameBridgeRpcResult> => {
  const { tabId, frameUrlIncludes, harvestUrlIncludes, method } = params;
  const options = params.options ?? {};
  const donorGlobal = params.donorGlobal ?? DEFAULT_DONOR_GLOBAL;

  // 1. Poll the frame global until the interceptor has captured a donor.
  let donor = await readDonorFromFrame(tabId, frameUrlIncludes, donorGlobal);
  const deadline = Date.now() + HARVEST_TIMEOUT_MS;
  while (!donor && Date.now() < deadline) {
    await sleep(HARVEST_POLL_MS);
    donor = await readDonorFromFrame(tabId, frameUrlIncludes, donorGlobal);
  }
  if (!donor) {
    throw new FrameBridgeValidationError(
      `No donor request was captured in the frame matching "${frameUrlIncludes}" within ${HARVEST_TIMEOUT_MS}ms. ` +
        `Is the app tab open and active, and does its pre-script interceptor stash into "${donorGlobal}"?`,
    );
  }

  // 2. Reuse the donor's context.
  let donorBody: { context?: Record<string, unknown> };
  try {
    donorBody = JSON.parse(donor.requestBody);
  } catch {
    throw new FrameBridgeValidationError('Captured donor request body is not valid JSON.');
  }
  const context = donorBody.context;
  if (!context || typeof context !== 'object') {
    throw new FrameBridgeValidationError('Captured donor request has no `context` object to reuse.');
  }

  // Patch caller-supplied fields (e.g. the selection a stateful method is scoped
  // to) into the reused context before any replay.
  if (params.contextPatch) Object.assign(context, params.contextPatch);

  // 3. For a stateful method, refresh the edit-state via the prep call first.
  if (params.prepMethod) {
    const prep = await replayMethod(
      tabId,
      frameUrlIncludes,
      harvestUrlIncludes,
      donor,
      params.prepMethod,
      context,
      params.prepOptions ?? {},
    );
    if (prep.ewaResult) mergeContextFromResponse(context, prep.ewaResult);
  }

  // 4. Replay the commit.
  const { result } = await replayMethod(tabId, frameUrlIncludes, harvestUrlIncludes, donor, method, context, options);
  return result;
};

/**
 * WebSocket command wrapper for `browser.frameBridgeRpc`. Validates params,
 * runs the bridge, and sends the JSON-RPC result.
 *
 * @param params - `{ tabId, frameUrlIncludes, harvestUrlIncludes, method, options?, donorGlobal?, prepMethod?, prepOptions? }`
 */
export const handleBrowserFrameBridgeRpc = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const tabId = requireTabId(params, id);
    if (tabId === null) return;
    const frameUrlIncludes = requireStringParam(params, 'frameUrlIncludes', id);
    if (frameUrlIncludes === null) return;
    const harvestUrlIncludes = requireStringParam(params, 'harvestUrlIncludes', id);
    if (harvestUrlIncludes === null) return;
    const method = requireStringParam(params, 'method', id);
    if (method === null) return;
    const options =
      params.options && typeof params.options === 'object' && !Array.isArray(params.options)
        ? (params.options as Record<string, unknown>)
        : {};
    const donorGlobal =
      typeof params.donorGlobal === 'string' && params.donorGlobal.length > 0 ? params.donorGlobal : undefined;
    const prepMethod =
      typeof params.prepMethod === 'string' && params.prepMethod.length > 0 ? params.prepMethod : undefined;
    const prepOptions =
      params.prepOptions && typeof params.prepOptions === 'object' && !Array.isArray(params.prepOptions)
        ? (params.prepOptions as Record<string, unknown>)
        : undefined;
    const contextPatch =
      params.contextPatch && typeof params.contextPatch === 'object' && !Array.isArray(params.contextPatch)
        ? (params.contextPatch as Record<string, unknown>)
        : undefined;

    const result = await runFrameBridgeRpc({
      tabId,
      frameUrlIncludes,
      harvestUrlIncludes,
      method,
      options,
      donorGlobal,
      prepMethod,
      prepOptions,
      contextPatch,
    });
    sendSuccessResult(id, result);
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      sendValidationError(id, err.message);
      return;
    }
    sendErrorResult(id, err);
  }
};
