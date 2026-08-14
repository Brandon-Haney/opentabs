import { fetchInFrame } from './frame-fetch.js';
import { requireStringParam, requireTabId, requireUrl, sendErrorResult, sendSuccessResult } from './helpers.js';

/**
 * Issue an HTTP request from inside a specific child frame (out-of-process
 * iframe) of a tab, so the request is same-origin to that frame and carries its
 * cookies. Cross-origin embedded apps (e.g. Office Web Apps) expose internal
 * APIs that reject calls from the host page's origin (no CORS) — this runs the
 * fetch in the embedded frame's own context where those calls are same-origin.
 *
 * When `donorGlobal` is set the request is a replay: the frame supplies its own
 * `url`, `method`, `body`, and live auth headers from the captured request stored
 * under that global, so those may be omitted. See {@link fetchInFrame}.
 *
 * @param params - `{ tabId, frameUrlIncludes, url?, method?, headers?, body?, donorGlobal? }`.
 *   `frameUrlIncludes` selects the child frame by a substring of its URL.
 * @returns `{ frameId, status, ok, body }` with the response.
 */
export const handleBrowserFetchInFrame = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const tabId = requireTabId(params, id);
    if (tabId === null) return;
    const frameUrlIncludes = requireStringParam(params, 'frameUrlIncludes', id);
    if (frameUrlIncludes === null) return;

    const donorGlobal =
      typeof params.donorGlobal === 'string' && params.donorGlobal.length > 0 ? params.donorGlobal : undefined;

    // Without a donor the URL is required; with one it is optional and defaults to
    // the captured request's own URL.
    let url: string | undefined;
    if (donorGlobal) {
      url = typeof params.url === 'string' && params.url.length > 0 ? params.url : undefined;
    } else {
      const required = requireUrl(params, id);
      if (required === null) return;
      url = required;
    }

    const method = typeof params.method === 'string' ? params.method : undefined;
    const headers =
      params.headers && typeof params.headers === 'object' && !Array.isArray(params.headers)
        ? (params.headers as Record<string, string>)
        : {};
    const body = typeof params.body === 'string' ? params.body : undefined;

    const result = await fetchInFrame(tabId, frameUrlIncludes, { url, method, headers, body, donorGlobal });
    sendSuccessResult(id, result);
  } catch (err) {
    sendErrorResult(id, err);
  }
};
