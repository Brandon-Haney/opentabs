import { attachExistingChildTargets, getLatestRawRequest, isCapturing, startCapture } from '../network-capture.js';
import { fetchInFrame } from './frame-fetch.js';
import {
  requireStringParam,
  requireTabId,
  sendErrorResult,
  sendSuccessResult,
  sendValidationError,
} from './helpers.js';

/** How long to wait for a fresh donor request to appear in the capture buffer. */
const HARVEST_TIMEOUT_MS = 30_000;
/** Poll interval while waiting for a donor request. */
const HARVEST_POLL_MS = 750;

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
 * Harvest-and-replay bridge for coauth-context RPC APIs (e.g. the Office Web
 * Apps `EwaInternalWebService`). One atomic operation:
 *   1. ensure network capture is active on the tab and attach the (possibly
 *      pre-existing) embedded frame so its internal traffic is captured;
 *   2. harvest the freshest captured request matching `harvestUrlIncludes` that
 *      carries a live session `context` — reusing its auth headers and context;
 *   3. build `{ context, ...options }` with a fresh `ClientRequestId` and derive
 *      the target URL for `method` from the donor URL;
 *   4. replay the POST inside the embedded frame (same-origin, cookies + tokens).
 *
 * @param params - `{ tabId, frameUrlIncludes, harvestUrlIncludes, method, options? }`
 * @returns `{ frameId, status, ok, errors, response }` — `errors` is the parsed
 *   `EwaResult.Errors` array when the response is that shape (empty = success).
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

    // 1. Ensure network capture is active on the tab.
    if (!isCapturing(tabId)) {
      await startCapture(tabId, 100, harvestUrlIncludes);
    }
    await attachExistingChildTargets(tabId, frameUrlIncludes);

    // 2. Harvest the freshest donor carrying live session context. An
    //    out-of-process embedded frame that loaded *before* capture started was
    //    never auto-attached (Target.setAutoAttach binds future targets only, and
    //    OOPIFs are not enumerable via Target.getTargets), so its traffic is not
    //    captured and the buffer is cold. Reload the tab once: the frame is then
    //    recreated under the armed auto-attach and its internal traffic begins
    //    flowing into the capture. Capture stays warm afterward, so subsequent
    //    bridge calls on the same tab harvest instantly with no reload.
    let donor = getLatestRawRequest(tabId, harvestUrlIncludes, 'context');
    if (!donor) {
      await chrome.tabs.reload(tabId);
    }
    const deadline = Date.now() + HARVEST_TIMEOUT_MS;
    while (!donor && Date.now() < deadline) {
      await sleep(HARVEST_POLL_MS);
      donor = getLatestRawRequest(tabId, harvestUrlIncludes, 'context');
    }
    if (!donor?.requestHeaders || !donor.requestBody) {
      sendValidationError(
        id,
        `No donor request matching "${harvestUrlIncludes}" with a session context was captured within ${HARVEST_TIMEOUT_MS}ms. Is the app tab open and active?`,
      );
      return;
    }

    // 3. Build the replay body: reuse the donor's context, refresh ClientRequestId.
    let donorBody: { context?: Record<string, unknown> };
    try {
      donorBody = JSON.parse(donor.requestBody);
    } catch {
      sendValidationError(id, 'Captured donor request body is not valid JSON.');
      return;
    }
    const context = donorBody.context;
    if (!context || typeof context !== 'object') {
      sendValidationError(id, 'Captured donor request has no `context` object to reuse.');
      return;
    }
    if ('ClientRequestId' in context) context.ClientRequestId = crypto.randomUUID();

    const headers = buildReplayHeaders(donor.requestHeaders);
    const targetUrl = deriveTargetUrl(donor.url, harvestUrlIncludes, method);
    const body = JSON.stringify({ context, ...options });

    // 4. Replay inside the embedded frame.
    const result = await fetchInFrame(tabId, frameUrlIncludes, { url: targetUrl, method: 'POST', headers, body });

    // Surface EwaResult.Errors when the response is that shape (empty = success).
    let errors: unknown[] | undefined;
    let response: unknown = result.body;
    try {
      const parsed = JSON.parse(result.body) as { d?: { Errors?: unknown[] } };
      response = parsed.d ?? parsed;
      if (parsed.d && Array.isArray(parsed.d.Errors)) errors = parsed.d.Errors;
    } catch {
      // Non-JSON response — return the raw body.
    }

    sendSuccessResult(id, { frameId: result.frameId, status: result.status, ok: result.ok, errors, response });
  } catch (err) {
    sendErrorResult(id, err);
  }
};
