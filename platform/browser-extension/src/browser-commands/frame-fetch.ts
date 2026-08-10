/**
 * Shared core for issuing an HTTP request from inside a specific child frame
 * (out-of-process iframe) of a tab. The fetch runs in the frame's MAIN world, so
 * it is same-origin to that frame and carries its session cookies — the way to
 * reach internal APIs of a cross-origin embedded app (e.g. Office Web Apps) that
 * reject calls from the host page's origin because they send no CORS headers.
 *
 * Used by both `browser.fetchInFrame` (raw replay) and `browser.frameBridgeRpc`
 * (harvest-and-replay).
 */

/** Maximum response body length returned to the caller before truncation. */
export const MAX_FRAME_FETCH_RESPONSE = 200_000;

/**
 * Frame global marking that a bridge replay is in flight.
 *
 * The replay runs in the frame's MAIN world, so it goes through whatever `fetch`
 * a pre-script installed in that realm. A pre-script that captures the app's
 * requests therefore captures ours too — and since the bridge reuses the freshest
 * captured request as its donor, every replay after the first would build on a
 * context sourced from the previous replay instead of from the app. A pre-script
 * skips capture while this is non-zero to tell the two apart.
 *
 * A depth counter rather than a boolean, because replays can overlap and the
 * inner one finishing must not clear the marker for the outer one. Honouring it
 * is optional: a pre-script that ignores it behaves exactly as before.
 */
export const BRIDGE_REPLAY_DEPTH_GLOBAL = '__otbBridgeReplayDepth';

/** Result of a successful in-frame fetch. */
export interface FrameFetchResult {
  frameId: number;
  status: number;
  ok: boolean;
  body: string;
}

/**
 * Locate the child frame whose URL contains `frameUrlIncludes` and run a fetch
 * inside it. Returns `{ frameId, status, ok, body }` on success.
 *
 * Throws with a descriptive message when no matching frame exists or the in-frame
 * fetch itself fails (e.g. the network request was blocked). Selecting the frame
 * by a specific substring matters: a page can host several frames on the same host
 * (a nested opaque-origin helper alongside the real document frame), and a fetch
 * from the wrong one is cross-origin and fails. Pass the document frame's URL
 * substring (e.g. "xlviewerinternal.aspx"), not just the host.
 */
export const fetchInFrame = async (
  tabId: number,
  frameUrlIncludes: string,
  request: { url: string; method: string; headers: Record<string, string>; body?: string },
): Promise<FrameFetchResult> => {
  // An all-frames probe returns one result per frame, each tagged with frameId.
  const frameProbe = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => location.href,
  });
  const match = frameProbe.find(frame => typeof frame.result === 'string' && frame.result.includes(frameUrlIncludes));
  if (!match || match.frameId === undefined) {
    throw new Error(`No frame in tab ${tabId} with a URL containing "${frameUrlIncludes}"`);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [match.frameId] },
    world: 'MAIN',
    func: async (
      requestUrl: string,
      requestMethod: string,
      requestHeaders: Record<string, string>,
      requestBody: string | null,
      maxLength: number,
      depthGlobal: string,
    ) => {
      const scope = globalThis as unknown as Record<string, number | undefined>;
      try {
        // Raised only around the call itself: a pre-script's interceptor records
        // the request synchronously as `fetch` is invoked, so the marker needs to
        // cover that moment and nothing more. Reading the body afterwards is
        // outside it, keeping the window in which a genuine app request would be
        // skipped as narrow as possible.
        scope[depthGlobal] = (scope[depthGlobal] ?? 0) + 1;
        let response: Response;
        try {
          response = await fetch(requestUrl, {
            method: requestMethod,
            headers: requestHeaders,
            credentials: 'include',
            body: requestBody ?? undefined,
          });
        } finally {
          scope[depthGlobal] = (scope[depthGlobal] ?? 1) - 1;
        }
        const text = await response.text();
        return {
          status: response.status,
          ok: response.ok,
          body: text.length > maxLength ? `${text.slice(0, maxLength)}... (truncated)` : text,
        };
      } catch (err) {
        return { error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    args: [
      request.url,
      request.method,
      request.headers,
      request.body ?? null,
      MAX_FRAME_FETCH_RESPONSE,
      BRIDGE_REPLAY_DEPTH_GLOBAL,
    ],
  });

  const result = results[0]?.result as { status: number; ok: boolean; body: string } | { error: string } | undefined;
  if (!result) {
    throw new Error(`In-frame fetch returned no result for tab ${tabId}`);
  }
  if ('error' in result) {
    throw new Error(result.error);
  }
  return { frameId: match.frameId, status: result.status, ok: result.ok, body: result.body };
};
