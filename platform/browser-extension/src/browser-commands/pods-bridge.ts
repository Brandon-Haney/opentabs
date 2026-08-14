/**
 * Pods co-authoring write engine.
 *
 * PowerPoint on the web edits an OPEN deck by POSTing incremental revisions to
 * `/pods/PowerPoint.ashx` in its cross-origin editor frame — the only channel
 * that can change a file while it is open, since Graph's full-file PUT is refused
 * under the co-authoring lock. A plugin tool cannot make that call itself: the
 * adapter runs in the SharePoint host frame, and the endpoint is same-origin only
 * to the `*.officeapps.live.com` editor frame.
 *
 * A tool instead builds the revision body — with two placeholder tokens standing
 * in for the identity values that can only be minted at write time — and returns a
 * `__podsBridge` directive. This engine, run by the extension where the dispatch
 * tab is already known, reads the live co-authoring head from the editor's own
 * poll traffic (via the pre-script's in-frame sentinel), mints a fresh client
 * GUID, substitutes both into the body, and replays the POST inside the editor
 * frame with the frame-local donor's live WOPI headers. The donor and head are
 * read only inside the frame and never cross back into the service worker.
 *
 * It is a sibling of the EWA harvest-and-replay bridge (`frame-bridge-rpc`), not a
 * mode of it: the pods `{Mode,srs}` envelope shares none of EWA's `{context,…}`
 * shape, prep/commit flow, or `EwaResult` parsing. The two engines share only the
 * leaf primitive `fetchInFrame` and the validation-error type.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { fetchInFrame } from './frame-fetch.js';

/** Placeholder a tool writes where the fresh client GUID belongs (run `|1`, revision `|2`, object group `|3`, and the target run-reference). One replace fills every slot. */
const DEFAULT_GUID_TOKEN = '__OTB_PODS_GUID__';
/** Placeholder a tool writes where the current co-authoring head belongs (`BaseId`, top-level `ExpectedLatestId`). */
const DEFAULT_HEAD_TOKEN = '__OTB_PODS_HEAD__';
/**
 * How many times to re-read the head and re-POST after a conflict. The editor's
 * own polls and any co-author advance the head continuously, so a base captured
 * microseconds before the POST can already be superseded — a stale base answers
 * HTTP 200 with `IsConflict: true`. Re-reading and re-minting resolves it; a small
 * bound stops a genuinely wedged session from looping.
 */
const MAX_CONFLICT_RETRIES = 3;

/** A `__podsBridge` directive, validated. */
export interface PodsBridgeParams {
  tabId: number;
  /** Substring selecting the PowerPoint editor OOPIF (e.g. `powerpoint.officeapps.live.com`). */
  frameUrlIncludes: string;
  /** Frame global the pre-script stashes the freshest `/pods` request into, for the auth-header replay. */
  donorGlobal: string;
  /** URL marker the pre-script answers in-frame with `{ head, ts }` — the current co-authoring head. */
  headSentinel: string;
  /** The `{Mode,srs}` revision body, with the identity tokens embedded. */
  body: Record<string, unknown>;
  /** Token standing in for the minted GUID (default {@link DEFAULT_GUID_TOKEN}). */
  guidToken?: string;
  /** Token standing in for the read head (default {@link DEFAULT_HEAD_TOKEN}). */
  headToken?: string;
}

/** Result of a pods write. `failure` is set (and raised to a dispatch error) when the write did not apply. */
export interface PodsBridgeResult {
  frameId: number;
  status: number;
  ok: boolean;
  /** The head the accepted (or last-attempted) revision was based on. */
  head: string;
  /** The pods `StatusCode` (0 = accepted). */
  statusCode?: number;
  /** Whether the server rejected the base as stale. */
  isConflict?: boolean;
  /** How many extra attempts a conflict cost (0 when the first POST applied). */
  retries?: number;
  /** The parsed pods response envelope. */
  response?: unknown;
  /** Present only on a write that did not apply — a human-readable reason. */
  failure?: string;
}

/** The `{StatusCode, IsConflict, ServerError?}` object a pods response carries under `Responses[0][1]`. */
interface PodsResponseEntry {
  StatusCode?: number;
  IsConflict?: boolean;
  ServerError?: { Code?: number; Source?: number };
}

/** Pull the response entry out of a parsed pods envelope `{ Responses: [[type, entry]] }`. */
const podsResponseEntry = (parsed: unknown): PodsResponseEntry | undefined => {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const responses = (parsed as { Responses?: unknown }).Responses;
  if (!Array.isArray(responses) || responses.length === 0) return undefined;
  const first = responses[0];
  if (!Array.isArray(first) || first.length < 2) return undefined;
  const entry = first[1];
  return entry && typeof entry === 'object' ? (entry as PodsResponseEntry) : undefined;
};

/**
 * A pods write judged solely on its parsed payload — a refusal answers HTTP 200,
 * so `ok`/`status` cannot be trusted. Returns a reason string when the write did
 * not apply, or undefined when it did. `IsConflict` is reported separately so the
 * engine can retry it rather than fail outright.
 */
export const describePodsFailure = (entry: PodsResponseEntry | undefined): string | undefined => {
  if (!entry) return 'pods response carried no Responses payload';
  if (entry.IsConflict === true) return 'pods write conflicted: the base revision was superseded before it applied';
  if (entry.StatusCode !== 0) {
    const se = entry.ServerError;
    const detail =
      se && (se.Code !== undefined || se.Source !== undefined) ? ` (ServerError ${se.Code}/${se.Source})` : '';
    return `pods write rejected with StatusCode ${entry.StatusCode}${detail}`;
  }
  return undefined;
};

/** Two pure substitutions over the serialized body: GUID first, then head. Both values are JSON-safe (hex + hyphen + pipe + digits), so the result stays valid JSON. */
export const substituteIdentity = (
  bodyJson: string,
  guidToken: string,
  guid: string,
  headToken: string,
  head: string,
): string => bodyJson.split(guidToken).join(guid).split(headToken).join(head);

/**
 * Read the current co-authoring head from the editor's in-frame sentinel. Tagged
 * with `donorGlobal` so it targets the exact frame that holds the live session (a
 * nested Office editor has sibling frames on the same host) and fails fast with a
 * clear message when no session is present.
 */
const readHead = async (params: PodsBridgeParams): Promise<string> => {
  const url = `https://opentabs.invalid/${params.headSentinel}`;
  const res = await fetchInFrame(params.tabId, params.frameUrlIncludes, {
    headers: {},
    donorGlobal: params.donorGlobal,
    url,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new FrameBridgeValidationError(`Head sentinel returned non-JSON: ${res.body.slice(0, 120)}`);
  }
  const head = (parsed as { head?: unknown } | null)?.head;
  if (typeof head !== 'string' || head.length === 0) {
    throw new FrameBridgeValidationError(
      'No co-authoring head is available yet — the editor has not polled since the deck opened. Open and activate the deck, then retry.',
    );
  }
  return head;
};

/**
 * Read the head, mint a GUID, substitute both into the body, and POST it inside
 * the editor frame. Retries a conflict (stale base) up to {@link MAX_CONFLICT_RETRIES}
 * times, each time re-reading the now-current head and minting a fresh GUID.
 */
export const runPodsBridge = async (params: PodsBridgeParams): Promise<PodsBridgeResult> => {
  const guidToken = params.guidToken ?? DEFAULT_GUID_TOKEN;
  const headToken = params.headToken ?? DEFAULT_HEAD_TOKEN;
  const bodyJson = JSON.stringify(params.body);

  let result: PodsBridgeResult | undefined;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const head = await readHead(params);
    const guid = crypto.randomUUID();
    const finalBody = substituteIdentity(bodyJson, guidToken, guid, headToken, head);
    const res = await fetchInFrame(params.tabId, params.frameUrlIncludes, {
      headers: {},
      donorGlobal: params.donorGlobal,
      method: 'POST',
      body: finalBody,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return {
        frameId: res.frameId,
        status: res.status,
        ok: res.ok,
        head,
        retries: attempt,
        response: res.body,
        failure: `pods response was not JSON: ${res.body.slice(0, 120)}`,
      };
    }

    const entry = podsResponseEntry(parsed);
    const failure = describePodsFailure(entry);
    result = {
      frameId: res.frameId,
      status: res.status,
      ok: res.ok,
      head,
      retries: attempt,
      ...(typeof entry?.StatusCode === 'number' ? { statusCode: entry.StatusCode } : {}),
      ...(entry?.IsConflict === true ? { isConflict: true } : {}),
      response: parsed,
      ...(failure ? { failure } : {}),
    };

    // Retry only a conflict — a stale base is transient, any other rejection is not.
    if (entry?.IsConflict === true && attempt < MAX_CONFLICT_RETRIES) continue;
    return result;
  }
  // Unreachable: the loop returns on the final attempt. Satisfies the type checker.
  return result as PodsBridgeResult;
};
