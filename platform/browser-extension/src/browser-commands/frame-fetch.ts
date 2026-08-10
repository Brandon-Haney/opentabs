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

/**
 * Maximum response body length, in characters, returned to the caller.
 *
 * The cap is applied in the page, before the value is structured-cloned out of
 * the frame, because everything past this point pays for the size repeatedly:
 * across the process boundary into the service worker, over the WebSocket to the
 * MCP server, and finally into an agent's context window.
 *
 * A response that would exceed it is better reshaped than raised — see
 * {@link FrameFetchProjection}, which runs before this cap rather than after.
 */
export const MAX_FRAME_FETCH_RESPONSE = 200_000;

/**
 * Maximum number of items a projected list returns.
 *
 * A projection returns a structured-cloned value rather than text, so the
 * character cap above does not apply to it — without a limit of its own, a
 * dimension of every product a company sells would cross whole and land in an
 * agent's context. The count before capping is reported alongside, so a short
 * list is never mistaken for a complete one.
 */
export const MAX_PROJECTED_ITEMS = 500;

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

/**
 * Select and reshape part of a response, in the page, before it is measured
 * against {@link MAX_FRAME_FETCH_RESPONSE}.
 *
 * A filter over a store or product dimension answers with a tree whose nodes
 * carry nine fields each and runs past the cap — 231KB observed against a
 * 200,000-character limit — where the four fields a caller wants are a fraction
 * of that. Reshaping in the service worker would be too late: the body is cut
 * one process earlier, and the discarded part is exactly the part being asked
 * for.
 */
export interface FrameFetchProjection {
  /**
   * Dot path to the value to return, relative to the parsed response. A numeric
   * segment indexes an array (`Result.Items.0.Children`).
   */
  path: string;
  /**
   * Output key → source key. Omit to return matched values unchanged.
   * Keys absent from a node come back undefined rather than failing, since the
   * service decides the payload and a partial node is more useful than none.
   */
  fields?: Record<string, string>;
  /**
   * Name of the key holding a node's children. When set, the matched nodes are
   * walked depth-first and returned as one flat list rather than a tree — which
   * is what a caller choosing among them actually wants, and keeps a parent that
   * is itself selectable (an "All" row) in the result.
   */
  flattenChildren?: string;
}

/** Result of a successful in-frame fetch. */
export interface FrameFetchResult {
  frameId: number;
  status: number;
  ok: boolean;
  /**
   * The response body. When a projection was applied this is the envelope with
   * its payload removed — enough to judge success or failure, without the bulk.
   */
  body: string;
  /** The projected payload, present only when a projection was applied. */
  projected?: unknown;
  /**
   * Number of items the projection matched, before any cap. Present only when
   * the projected value is a list, so a caller can tell a capped list from a
   * complete one.
   */
  projectedTotal?: number;
  /**
   * Length of the response before projection and truncation.
   *
   * Reported so that a caller is never left to infer how much it did not see:
   * a projected result carries no marker of its own, and silence would read as
   * "that was all of it".
   */
  rawLength?: number;
  /** True when the body was cut at the cap rather than reshaped. */
  truncated?: boolean;
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
 *
 * `projection` reshapes the payload inside the frame, before the size cap.
 */
export const fetchInFrame = async (
  tabId: number,
  frameUrlIncludes: string,
  request: { url: string; method: string; headers: Record<string, string>; body?: string },
  projection?: FrameFetchProjection,
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
      shape: FrameFetchProjection | null,
      maxItems: number,
    ) => {
      // Everything this function needs is defined inside it: chrome.scripting
      // serialises it with Function.prototype.toString, so it cannot close over
      // module scope. That is why the projection logic is repeated here rather
      // than imported — it has to run in the page to be of any use.
      const MAX_DEPTH = 32;

      const resolvePath = (root: unknown, path: string): unknown => {
        let current = root;
        for (const segment of path.split('.')) {
          if (current === null || current === undefined) return undefined;
          if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index)) return undefined;
            current = current[index];
            continue;
          }
          if (typeof current !== 'object') return undefined;
          current = (current as Record<string, unknown>)[segment];
        }
        return current;
      };

      const pickFields = (node: unknown, fields?: Record<string, string>): unknown => {
        if (!fields || !node || typeof node !== 'object' || Array.isArray(node)) return node;
        const source = node as Record<string, unknown>;
        const picked: Record<string, unknown> = {};
        for (const key of Object.keys(fields)) picked[key] = source[fields[key] as string];
        return picked;
      };

      const flatten = (nodes: unknown[], out: unknown[], depth: number): void => {
        if (depth > MAX_DEPTH || !shape) return;
        for (const node of nodes) {
          out.push(pickFields(node, shape.fields));
          const children =
            node && typeof node === 'object'
              ? (node as Record<string, unknown>)[shape.flattenChildren as string]
              : undefined;
          if (Array.isArray(children)) flatten(children, out, depth + 1);
        }
      };

      const project = (envelope: unknown): unknown => {
        if (!shape) return null;
        const selected = resolvePath(envelope, shape.path);
        if (selected === undefined) return null;
        if (shape.flattenChildren && Array.isArray(selected)) {
          const flattened: unknown[] = [];
          flatten(selected, flattened, 0);
          return flattened;
        }
        return Array.isArray(selected)
          ? selected.map(node => pickFields(node, shape.fields))
          : pickFields(selected, shape.fields);
      };

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

        if (shape) {
          try {
            const parsed = JSON.parse(text) as { d?: Record<string, unknown> };
            const envelope = parsed?.d ?? parsed;
            const full = project(envelope);
            const isList = Array.isArray(full);
            const projected = isList ? (full as unknown[]).slice(0, maxItems) : full;
            // The envelope minus its payload: the error fields that decide
            // success or failure are all outside `Result`, and `Result` is the
            // part that does not fit.
            const { Result: _payload, ...rest } = envelope as Record<string, unknown>;
            return {
              status: response.status,
              ok: response.ok,
              body: JSON.stringify({ d: rest }),
              projected,
              ...(isList ? { projectedTotal: (full as unknown[]).length } : {}),
              rawLength: text.length,
            };
          } catch {
            // Not the JSON envelope this expects — fall through and return the
            // body as-is rather than losing it to a failed reshape.
          }
        }

        return {
          status: response.status,
          ok: response.ok,
          body: text.length > maxLength ? `${text.slice(0, maxLength)}... (truncated)` : text,
          rawLength: text.length,
          truncated: text.length > maxLength,
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
      projection ?? null,
      MAX_PROJECTED_ITEMS,
    ],
  });

  const result = results[0]?.result as
    | {
        status: number;
        ok: boolean;
        body: string;
        projected?: unknown;
        projectedTotal?: number;
        rawLength?: number;
        truncated?: boolean;
      }
    | { error: string }
    | undefined;
  if (!result) {
    throw new Error(`In-frame fetch returned no result for tab ${tabId}`);
  }
  if ('error' in result) {
    throw new Error(result.error);
  }
  return { frameId: match.frameId, ...result };
};
