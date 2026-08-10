import { type FrameFetchProjection, fetchInFrame, MAX_FRAME_FETCH_RESPONSE } from './frame-fetch.js';
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
 * Read named globals out of the child frame whose URL contains
 * `frameUrlIncludes`. Runs in the frame's MAIN world — the same realm the
 * pre-script interceptor writes into. Returns a name→value map, or null when no
 * matching frame is present.
 *
 * Every global is read in one probe so the donor and any values keyed to it come
 * from a single snapshot of the frame rather than drifting between round trips.
 */
const readFrameGlobals = async (
  tabId: number,
  frameUrlIncludes: string,
  globalNames: string[],
): Promise<Record<string, unknown> | null> => {
  const probe = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: (names: string[]) => ({
      href: location.href,
      values: Object.fromEntries(names.map(name => [name, (globalThis as Record<string, unknown>)[name] ?? null])),
    }),
    args: [globalNames],
  });
  const match = probe.find(frame => {
    const r = frame.result as { href?: string } | undefined;
    return typeof r?.href === 'string' && r.href.includes(frameUrlIncludes);
  });
  if (!match) return null;
  return (match.result as { values?: Record<string, unknown> } | undefined)?.values ?? {};
};

/** Parsed outcome of a frame-bridge RPC invocation. */
export interface FrameBridgeRpcResult {
  frameId: number;
  status: number;
  ok: boolean;
  /** Parsed `EwaResult.Errors` when the response is that shape (empty = success). */
  errors?: unknown[];
  response: unknown;
  /**
   * Size of the service's response before any projection or truncation, in
   * characters.
   *
   * Reported so a projected result never reads as the whole of what the service
   * sent: a caller comparing it against what came back can see how much was
   * reshaped away, and narrow the request when the gap is large.
   */
  rawLength?: number;
  /**
   * How many items the projection matched before any cap.
   *
   * When this exceeds the length of `response`, the list is partial: the rest
   * exists and was not returned. Narrow the request rather than treating what
   * came back as the whole set.
   */
  total?: number;
  /**
   * Why the call failed, when it did. Present only on failure, so a caller can
   * treat its absence as success rather than having to know the several places
   * this kind of service hides a refusal.
   */
  failure?: string;
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
   * Whether the prep response's edit-state is merged into the context before the
   * commit. Defaults to true, which is what a stateful dialog method needs.
   *
   * Set false when the prep is a lookup rather than a get-state call: its
   * response describes a read, and folding a read's session token and revision
   * counters into a context that is about to be written with has no basis and
   * the service can reject the commit outright.
   */
  prepMergesContext?: boolean;
  /**
   * Values to lift out of the prep call's response and into the commit's
   * options (see {@link BridgePrepSelection}). Requires `prepMethod`.
   */
  optionsFromPrep?: BridgePrepSelection[];
  /**
   * HTTP verb for the prep call. Defaults to POST, like the commit.
   *
   * Reading state is commonly the GET half of these APIs, so a prep that reads
   * a version counter or a field well often has to be a GET even when the commit
   * it feeds is a POST.
   */
  prepHttpMethod?: 'GET' | 'POST';
  /** {@link contextKeys} for the prep call, which needs its own when it is a GET. */
  prepContextKeys?: string[];
  /**
   * Commit options taken verbatim from the prep response, as
   * `{ optionDotPath: responseDotPath }`.
   *
   * The sibling {@link optionsFromPrep} resolves a *name* to an id by searching a
   * list; this lifts a scalar the caller cannot know from a fixed place in the
   * response. Optimistic-concurrency counters are the case it exists for: a write
   * must echo the current ones, they change on every operation including failed
   * ones, and so a caller that reads them in a separate call is racing anything
   * else touching the document. Read here, they cannot be stale — nothing happens
   * between the read and the write that uses it.
   */
  optionsFromPrepPaths?: Record<string, string>;
  /**
   * Top-level fields to patch into the reused `context` before replaying — e.g.
   * a `ViewportStateChange` selection that a selection-scoped stateful method
   * requires but a poll-sourced donor context lacks. Shallow-merged.
   */
  contextPatch?: Record<string, unknown>;
  /**
   * Option fields whose values live in the frame rather than in the caller,
   * given as `{ optionName: frameGlobalName }`. Each named global is read from
   * the embedded frame and merged into `options` before the replay.
   *
   * This exists for values a method requires that only the embedded app can
   * mint — an Office `Refresh`, for instance, requires a per-session AAD token
   * that exists solely inside the document frame. Routing it this way keeps the
   * credential in the frame: it never reaches the host page, the adapter, or a
   * tool result. Values already present in `options` are overwritten.
   */
  optionsFromFrameGlobals?: Record<string, string>;
  /**
   * HTTP verb for the replayed call. Defaults to POST.
   *
   * Some methods on these services are GETs that carry the whole request —
   * context included — in the query string rather than a body. Reading state
   * (field lists, filter members) is commonly the GET half of the API.
   */
  httpMethod?: 'GET' | 'POST';
  /**
   * Restrict the reused `context` to these keys. Applies to both verbs but
   * exists for GET, where the context travels in the URL: a donor context can
   * carry large fields that no GET needs and that would overflow a practical
   * URL length. Omit to send the context whole.
   */
  contextKeys?: string[];
  /**
   * Reshape the response before returning it (see {@link BridgeProjection}).
   * Applies to the final call only — a prep call's response is consumed
   * internally to refresh the context and never reaches the caller.
   */
  projection?: BridgeProjection;
  /**
   * Service error code → guidance appended to the failure message for that code.
   *
   * What a given code means, and what the user should do about it, is knowledge
   * about the embedded app rather than about the bridge, so the plugin supplies
   * it and the engine hard-codes none of it.
   */
  errorHints?: Record<string, string>;
}

/** Error thrown by {@link runFrameBridgeRpc} when no valid donor is available. */
export class FrameBridgeValidationError extends Error {}

/**
 * Narrow an untrusted value to a plain `Record<string, string>`, dropping any
 * entry whose value is not a string. Returns undefined when nothing usable
 * remains, so callers can treat "absent" and "empty" identically.
 */
export const asStringMap = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

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

/** Marker {@link fetchInFrame} appends to a response body it had to truncate. */
const TRUNCATION_MARKER = '... (truncated)';

/** Append the plugin's guidance for `code`, when it has any. */
const withHint = (summary: string, code: string, hints?: Record<string, string>): string => {
  const hint = hints?.[code];
  return hint ? `${summary} ${hint}` : summary;
};

/** Read a non-empty string property, or undefined when it is absent or another type. */
const stringProp = (obj: Record<string, unknown>, key: string): string | undefined =>
  typeof obj[key] === 'string' && (obj[key] as string).length > 0 ? (obj[key] as string) : undefined;

/**
 * Describe why a replayed call failed, or null when it succeeded.
 *
 * These services report a refusal in two unrelated places, and a caller checking
 * only one reads the other as success. `EwaResult.Errors` carries the service's
 * own refusals; a tunnelled object-model batch instead reports its error nested
 * under `Result.ResponseBody[].Error`, leaving the outer array empty and the
 * status 200. Both are checked here so no caller has to know that.
 *
 * A truncated body is reported as a failure too. It cannot be parsed, so it
 * yields no error array at all — which would otherwise be indistinguishable from
 * a clean success.
 */
export const describeBridgeFailure = (
  result: Pick<FrameBridgeRpcResult, 'ok' | 'status' | 'errors' | 'response'>,
  errorHints?: Record<string, string>,
): string | null => {
  const first = result.errors?.[0];
  // Keyed on the entry existing rather than on its shape: a non-empty error array
  // is a refusal whatever it contains, and falling through on an unexpected entry
  // would reintroduce the reads-as-success bug this exists to remove.
  if (first !== undefined) {
    const e = (first && typeof first === 'object' ? first : {}) as Record<string, unknown>;
    const code = stringProp(e, 'MessageIdName') ?? 'unknown error';
    const detail = stringProp(e, 'Description') ?? stringProp(e, 'Caption');
    // Not "nothing was applied", however much a caller would like to be told
    // that: a refusal can arrive part-way through a request that bundles several
    // steps, leaving the earlier ones in place. Observed on a refused PivotTable
    // creation, where the connection the same request created survived — so a
    // caller that trusted such a claim and retried would duplicate it.
    return withHint(
      `The application refused the operation: ${code}${detail ? ` — "${detail}"` : ''}. ` +
        'Check the current state before retrying: a request that bundles several steps can have applied some of them.',
      code,
      errorHints,
    );
  }

  const responseBody = nested(result.response, 'Result', 'ResponseBody');
  if (Array.isArray(responseBody)) {
    for (const entry of responseBody) {
      if (!entry || typeof entry !== 'object') continue;
      const nestedError = (entry as Record<string, unknown>).Error;
      if (!nestedError || typeof nestedError !== 'object') continue;
      const e = nestedError as Record<string, unknown>;
      const code = stringProp(e, 'Code') ?? 'unknown error';
      const detail = stringProp(e, 'Message');
      // Deliberately not "nothing was applied": this layer reports a failure
      // inside a batch of actions, and the steps before the failing one can have
      // taken effect and survived it. Claiming otherwise invites a retry that
      // duplicates whatever already applied.
      return withHint(
        `The application refused a step of the operation: ${code}${detail ? ` — "${detail}"` : ''}. ` +
          'It was a batch, so earlier steps in it may already have applied — check the current state before retrying.',
        code,
        errorHints,
      );
    }
  }

  if (!result.ok) {
    return `The replayed request failed at the HTTP level (status ${result.status}). Nothing was applied.`;
  }

  if (typeof result.response === 'string' && result.response.endsWith(TRUNCATION_MARKER)) {
    return (
      `The response exceeded ${MAX_FRAME_FETCH_RESPONSE} characters and was truncated, so whether the operation ` +
      'applied could not be determined. Narrow the request — read a smaller range, or pass a projection.'
    );
  }

  return null;
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

/** Narrow a context to `keys`, preserving only those actually present. */
const pickContextKeys = (context: Record<string, unknown>, keys?: string[]): Record<string, unknown> => {
  if (!keys || keys.length === 0) return context;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in context) picked[key] = context[key];
  }
  return picked;
};

/**
 * Encode `{ context, ...options }` as query parameters, replacing any query the
 * donor URL already carried apart from parameters the service routes on (which
 * are preserved from the donor, e.g. a cluster hint).
 *
 * Every value is JSON-encoded, including strings — these services deserialize
 * each GET parameter as JSON, so a string argument travels with its quotes
 * (`?currentSheetName="Sheet1"`, verified against live traffic). Numbers,
 * booleans and null encode identically either way, so only string parameters
 * are affected; sending one unquoted fails deserialization server-side and
 * surfaces as an opaque error rather than a parameter complaint.
 */
export const buildQueryUrl = (targetUrl: string, payload: Record<string, unknown>): string => {
  const url = new URL(targetUrl);
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    url.searchParams.set(name, JSON.stringify(value) ?? '');
  }
  return url.href;
};

/**
 * Reshape a reading method's response before it reaches the caller.
 *
 * These services answer with a large envelope wrapping the payload, and the
 * payload itself is often a lazily-nested tree carrying far more per node than
 * a caller wants. A tool cannot trim it: the adapter returns a directive and the
 * engine performs the call, so the handler never sees the response. Without
 * this, a read of a few thousand items ships roughly a megabyte of mostly
 * boilerplate to whoever called the tool.
 */
/**
 * Defined alongside the fetch because it is applied there — in the page, before
 * the response is measured against the size cap. See {@link FrameFetchProjection}.
 */
export type BridgeProjection = FrameFetchProjection;

/**
 * Take values out of the prep call's response and put them into the commit's
 * options.
 *
 * Some commits are addressed by an id the caller cannot know and cannot safely
 * guess — a PivotTable filter selects members by numeric id, where the id
 * follows the model's own ordering and a wrong one selects a different member
 * and reports success. The lookup that turns a name into that id is itself a
 * call into the frame, and a plugin tool handler never sees a bridge response,
 * so the two have to happen here, as one operation.
 *
 * Matching is by name and is required to be unambiguous: a term that matches
 * nothing, or more than one node, fails the whole call rather than picking. The
 * point of resolving by name is to remove the chance of silently acting on the
 * wrong row, which a "best match" would put straight back.
 */
export interface BridgePrepSelection {
  /** Option on the commit call to populate with the collected values. */
  option: string;
  /** How to flatten and reshape the prep response before matching. */
  projection: BridgeProjection;
  /** Field of a projected node to match `values` against. */
  matchField: string;
  /** Field of a projected node to collect from each match. */
  valueField: string;
  /** Terms to resolve. Each must match exactly one node. */
  values: string[];
  /** Collect the values as strings — some services want ids quoted. */
  asString?: boolean;
}

/** Depth cap for {@link applyProjection}; far beyond any real hierarchy. */
const MAX_FLATTEN_DEPTH = 32;

/** Walk a dot path, indexing arrays on numeric segments. Undefined if any step is missing. */
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

/**
 * Write `value` at a dot path inside `target`.
 *
 * Deliberately does not create missing branches. Every path here names a field
 * of a request the caller has already built, so one that does not resolve is a
 * typo or a shape that has changed — and quietly growing a new branch would send
 * a request the service ignores while the call reports success.
 */
export const assignAtPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.');
  const leaf = segments.pop();
  if (leaf === undefined || leaf === '') {
    throw new FrameBridgeValidationError(`"${path}" is not a usable option path.`);
  }
  let current: unknown = target;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new FrameBridgeValidationError(
        `Cannot set "${path}": "${segment}" is not an object on the options this call was built with.`,
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new FrameBridgeValidationError(
      `Cannot set "${path}": its parent is not an object on the options this call was built with.`,
    );
  }
  (current as Record<string, unknown>)[leaf] = value;
};

/** Apply a projection's field map to one node. Non-objects pass through unchanged. */
const pickFields = (node: unknown, fields?: Record<string, string>): unknown => {
  if (!fields || !node || typeof node !== 'object' || Array.isArray(node)) return node;
  const source = node as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const [outputKey, sourceKey] of Object.entries(fields)) picked[outputKey] = source[sourceKey];
  return picked;
};

/** Depth-first flatten of `nodes` over `childKey`, projecting each node as it is visited. */
const flattenNodes = (nodes: unknown[], projection: BridgeProjection, output: unknown[], depth: number): void => {
  if (depth > MAX_FLATTEN_DEPTH) return;
  for (const node of nodes) {
    output.push(pickFields(node, projection.fields));
    const children =
      node && typeof node === 'object'
        ? (node as Record<string, unknown>)[projection.flattenChildren as string]
        : undefined;
    if (Array.isArray(children)) flattenNodes(children, projection, output, depth + 1);
  }
};

/**
 * Select and reshape part of a response per {@link BridgeProjection}. Returns
 * null when the path does not resolve — which is the normal case for an errored
 * response, whose payload is absent and whose `errors` already say why.
 */
export const applyProjection = (response: unknown, projection: BridgeProjection): unknown => {
  const selected = resolvePath(response, projection.path);
  if (selected === undefined) return null;
  if (projection.flattenChildren && Array.isArray(selected)) {
    const flattened: unknown[] = [];
    flattenNodes(selected, projection, flattened, 0);
    return flattened;
  }
  return Array.isArray(selected)
    ? selected.map(node => pickFields(node, projection.fields))
    : pickFields(selected, projection.fields);
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
  httpMethod: 'GET' | 'POST' = 'POST',
  contextKeys?: string[],
  projection?: BridgeProjection,
): Promise<{ result: FrameBridgeRpcResult; envelope: unknown; ewaResult?: Record<string, unknown> }> => {
  if ('ClientRequestId' in context) context.ClientRequestId = crypto.randomUUID();
  const headers = buildReplayHeaders(donor.requestHeaders);
  const targetUrl = deriveTargetUrl(donor.url, harvestUrlIncludes, method);
  const sentContext = pickContextKeys(context, contextKeys);

  const fr =
    httpMethod === 'GET'
      ? await fetchInFrame(
          tabId,
          frameUrlIncludes,
          {
            url: buildQueryUrl(targetUrl, { context: sentContext, ...options }),
            method: 'GET',
            headers,
          },
          projection,
        )
      : await fetchInFrame(
          tabId,
          frameUrlIncludes,
          {
            url: targetUrl,
            method: 'POST',
            headers,
            body: JSON.stringify({ context: sentContext, ...options }),
          },
          projection,
        );

  const { response, errors, ewaResult } = parseEwaResult(fr.body);
  // With a projection the payload never left the page whole, so the projected
  // value stands in for it; `body` carries the envelope the errors live in.
  const projected = projection ? fr.projected : response;
  return {
    result: {
      frameId: fr.frameId,
      status: fr.status,
      ok: fr.ok,
      errors,
      response: projected,
      ...(fr.rawLength !== undefined ? { rawLength: fr.rawLength } : {}),
      ...(fr.projectedTotal !== undefined ? { total: fr.projectedTotal } : {}),
    },
    // The judged envelope, kept separate from the projected payload so the
    // failure check still sees the fields that report a refusal.
    envelope: response,
    ewaResult,
  };
};

/** Read a projected node's field as a string, or undefined when it is absent. */
const projectedField = (node: unknown, field: string): string | undefined => {
  if (!node || typeof node !== 'object') return undefined;
  const value = (node as Record<string, unknown>)[field];
  return value === undefined || value === null ? undefined : String(value);
};

/**
 * Resolve each of `selection.values` against the prep response, requiring
 * exactly one match apiece.
 *
 * Matching is case-insensitive containment, because the name a caller has is
 * rarely the whole display string — a store known as "ATL081" is published as
 * "ATL081 | DOUGLASVILLE | DOUGLASVILLE". An exact-equality rule would reject
 * every realistic input; containment plus a uniqueness requirement accepts the
 * realistic ones and refuses precisely the cases where a choice would have to be
 * invented.
 *
 * @throws {FrameBridgeValidationError} when a term matches no node or several.
 */
export const selectFromPrep = (response: unknown, selection: BridgePrepSelection): unknown[] => {
  const projected = applyProjection(response, selection.projection);
  const nodes = Array.isArray(projected) ? projected : projected === null ? [] : [projected];

  return selection.values.map(term => {
    const needle = term.trim().toLowerCase();
    const matches = nodes.filter(node => projectedField(node, selection.matchField)?.toLowerCase().includes(needle));

    if (matches.length === 0) {
      throw new FrameBridgeValidationError(
        `"${term}" matched none of the ${nodes.length} candidates the lookup returned. ` +
          'Check the spelling against what the model publishes, which may differ from how the value is written elsewhere.',
      );
    }
    if (matches.length > 1) {
      const named = matches
        .slice(0, 8)
        .map(node => `"${projectedField(node, selection.matchField) ?? '(unnamed)'}"`)
        .join(', ');
      const more = matches.length > 8 ? ` (and ${matches.length - 8} more)` : '';
      throw new FrameBridgeValidationError(
        `"${term}" is ambiguous — it matched ${matches.length} candidates: ${named}${more}. ` +
          'Nothing was changed. Give a term that identifies one of them exactly.',
      );
    }

    const value = projectedField(matches[0], selection.valueField);
    if (value === undefined) {
      throw new FrameBridgeValidationError(
        `"${term}" matched a candidate that carries no "${selection.valueField}", so there is nothing to send.`,
      );
    }
    return selection.asString ? value : Number(value);
  });
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
  // Copied, not aliased: frame-sourced values are merged in below and the
  // caller's object must not be mutated.
  const options = { ...(params.options ?? {}) };
  const donorGlobal = params.donorGlobal ?? DEFAULT_DONOR_GLOBAL;

  // Read the donor and any frame-sourced option values from the same snapshot.
  const fromFrameGlobals = params.optionsFromFrameGlobals ?? {};
  const globalNames = [donorGlobal, ...Object.values(fromFrameGlobals)];

  // 1. Poll the frame globals until the interceptor has captured a donor.
  let frameValues = await readFrameGlobals(tabId, frameUrlIncludes, globalNames);
  let donor = asCapturedDonor(frameValues?.[donorGlobal]);
  const deadline = Date.now() + HARVEST_TIMEOUT_MS;
  while (!donor && Date.now() < deadline) {
    await sleep(HARVEST_POLL_MS);
    frameValues = await readFrameGlobals(tabId, frameUrlIncludes, globalNames);
    donor = asCapturedDonor(frameValues?.[donorGlobal]);
  }
  if (!donor) {
    throw new FrameBridgeValidationError(
      `No donor request was captured in the frame matching "${frameUrlIncludes}" within ${HARVEST_TIMEOUT_MS}ms. ` +
        `Is the app tab open and active, and does its pre-script interceptor stash into "${donorGlobal}"?`,
    );
  }

  // Merge frame-sourced values into the options. A missing one is reported by
  // name: the alternative is a request that the server rejects with an opaque
  // error, which is far harder to act on.
  for (const [optionName, globalName] of Object.entries(fromFrameGlobals)) {
    const value = frameValues?.[globalName];
    if (value === undefined || value === null) {
      throw new FrameBridgeValidationError(
        `The frame matching "${frameUrlIncludes}" has not set "${globalName}", which supplies the ` +
          `"${optionName}" option for "${method}". This value is produced by the embedded app itself, so it ` +
          `only becomes available once the app has performed the corresponding action at least once this session.`,
      );
    }
    options[optionName] = value;
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
      params.prepHttpMethod,
      params.prepContextKeys,
    );
    if (prep.ewaResult && params.prepMergesContext !== false) mergeContextFromResponse(context, prep.ewaResult);

    // Both loops run before the commit, so an unresolved term or a missing
    // value fails without having written anything.
    for (const selection of params.optionsFromPrep ?? []) {
      options[selection.option] = selectFromPrep(prep.result.response, selection);
    }
    for (const [optionPath, responsePath] of Object.entries(params.optionsFromPrepPaths ?? {})) {
      const value = resolvePath(prep.result.response, responsePath);
      if (value === undefined) {
        throw new FrameBridgeValidationError(
          `The "${params.prepMethod}" response has nothing at "${responsePath}", which supplies "${optionPath}" for "${method}". ` +
            'Either the prep call failed or the response shape has changed; the commit was not sent.',
        );
      }
      assignAtPath(options, optionPath, value);
    }
  }

  // 4. Replay the commit. The projection travels with it and is applied in the
  // page, so a payload too large to cross the boundary is reshaped rather than
  // cut off — see FrameFetchProjection.
  const { result, envelope } = await replayMethod(
    tabId,
    frameUrlIncludes,
    harvestUrlIncludes,
    donor,
    method,
    context,
    options,
    params.httpMethod,
    params.contextKeys,
    params.projection,
  );
  // Judged against the envelope rather than the projected payload, because a
  // tunnelled object-model batch reports its error inside the response body —
  // which a projection replaces.
  const failure = describeBridgeFailure({ ...result, response: envelope }, params.errorHints);
  return failure === null ? result : { ...result, failure };
};

/** Narrow an untrusted value to a {@link BridgeProjection}, or undefined when it has no usable path. */
const toProjection = (raw: unknown): BridgeProjection | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (typeof source.path !== 'string' || source.path.length === 0) return undefined;
  const fields = asStringMap(source.fields);
  return {
    path: source.path,
    ...(fields ? { fields } : {}),
    ...(typeof source.flattenChildren === 'string' && source.flattenChildren.length > 0
      ? { flattenChildren: source.flattenChildren }
      : {}),
  } satisfies BridgeProjection;
};

/**
 * Narrow an untrusted value to {@link BridgePrepSelection}s.
 *
 * Entries missing any required part are dropped rather than half-applied: a
 * selection that silently lost its `values` would commit whatever the option
 * already held, which for a filter means selecting the wrong thing.
 */
export const toPrepSelections = (raw: unknown): BridgePrepSelection[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const selections = raw.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const projection = toProjection(source.projection);
    const values = Array.isArray(source.values) ? source.values.filter(v => typeof v === 'string') : [];
    if (
      !projection ||
      values.length === 0 ||
      typeof source.option !== 'string' ||
      typeof source.matchField !== 'string' ||
      typeof source.valueField !== 'string'
    ) {
      return [];
    }
    return [
      {
        option: source.option,
        projection,
        matchField: source.matchField,
        valueField: source.valueField,
        values,
        ...(source.asString === true ? { asString: true } : {}),
      } satisfies BridgePrepSelection,
    ];
  });
  return selections.length > 0 ? selections : undefined;
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
    const optionsFromFrameGlobals = asStringMap(params.optionsFromFrameGlobals);
    const errorHints = asStringMap(params.errorHints);
    const httpMethod = params.httpMethod === 'GET' ? 'GET' : undefined;
    const contextKeys = Array.isArray(params.contextKeys)
      ? params.contextKeys.filter((k): k is string => typeof k === 'string')
      : undefined;
    const rawProjection =
      params.projection && typeof params.projection === 'object' && !Array.isArray(params.projection)
        ? (params.projection as Record<string, unknown>)
        : undefined;
    const projection = toProjection(rawProjection);
    const optionsFromPrep = toPrepSelections(params.optionsFromPrep);
    const prepHttpMethod = params.prepHttpMethod === 'GET' ? 'GET' : undefined;
    const prepContextKeys = Array.isArray(params.prepContextKeys)
      ? params.prepContextKeys.filter((k): k is string => typeof k === 'string')
      : undefined;
    const optionsFromPrepPaths = asStringMap(params.optionsFromPrepPaths);

    const result = await runFrameBridgeRpc({
      tabId,
      frameUrlIncludes,
      harvestUrlIncludes,
      method,
      options,
      donorGlobal,
      prepMethod,
      prepOptions,
      optionsFromPrep,
      prepHttpMethod,
      prepContextKeys,
      optionsFromPrepPaths,
      ...(params.prepMergesContext === false ? { prepMergesContext: false } : {}),
      contextPatch,
      optionsFromFrameGlobals,
      httpMethod,
      contextKeys,
      projection,
      errorHints,
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
