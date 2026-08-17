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

/**
 * Where minted `Sequence` numbers start. The service treats a write repeating an
 * earlier write's `(session, Sequence)` pair as a client retransmit: it answers
 * `StatusCode 0` from the earlier acknowledgement and silently drops the revision
 * (verified live 2026-08-17 — back-to-back adds with the builder's constant
 * Sequence were accepted-then-dropped deterministically, and applied once the
 * number was unique). The editor's own counter starts near zero and advances one
 * per user action, so minted numbers sit far above it — colliding with the
 * EDITOR's side of the dedupe would silently drop the user's own edit instead.
 */
const SEQUENCE_FLOOR = 100_000;
/** Milliseconds per minted-sequence step, and the wrap that keeps the number a small int (~100 days). */
const SEQUENCE_CLOCK_MS = 1000;
const SEQUENCE_CLOCK_WRAP_MS = 8_640_000_000;

let lastMintedSequence = 0;

/**
 * A per-write `Sequence` number: unique within the session, monotonic within this
 * service worker, and re-seeded from the clock after a worker restart so numbers
 * are not re-issued across restarts either.
 */
const mintPodsSequence = (): number => {
  const clockFloor = SEQUENCE_FLOOR + Math.floor((Date.now() % SEQUENCE_CLOCK_WRAP_MS) / SEQUENCE_CLOCK_MS);
  lastMintedSequence = Math.max(lastMintedSequence + 1, clockFloor);
  return lastMintedSequence;
};

/**
 * The body with every type-3 (write) request's `Sequence` replaced by a minted
 * per-write number. Builders carry the captured constant for byte-fidelity with
 * their exemplars; the engine owns uniqueness, exactly as it owns the GUID and
 * head. Non-write entries and malformed shapes pass through untouched.
 */
const withMintedSequence = (body: Record<string, unknown>, sequence: number): Record<string, unknown> => {
  const srs = body.srs;
  if (!Array.isArray(srs)) return body;
  return {
    ...body,
    srs: srs.map(entry =>
      Array.isArray(entry) && entry[0] === 3 && entry[1] !== null && typeof entry[1] === 'object'
        ? [entry[0], { ...(entry[1] as Record<string, unknown>), Sequence: sequence }]
        : entry,
    ),
  };
};

/**
 * Sort a flat `[id, value, …]` pods property list ascending by id, preserving each
 * pair. The editor writes every object's properties sorted this way; a model-read
 * snapshot returns them unordered, so a constructed write must re-sort to match —
 * for some writes (e.g. a slide-list delete) the server silently ignores the change
 * otherwise. Shared by every pods write builder.
 */
export const sortPropertiesById = (properties: (string | number)[]): (string | number)[] => {
  const pairs: [string | number, string | number][] = [];
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key !== undefined && value !== undefined) pairs.push([key, value]);
  }
  pairs.sort((a, b) => Number(a[0]) - Number(b[0]));
  return pairs.flat();
};

/**
 * The revision to write, or a factory that re-derives it.
 *
 * A factory is invoked before **every** attempt, so a retry rebuilds the revision
 * against the document as it is now rather than replaying a snapshot taken before
 * the first try. That distinction is load-bearing: a structural revision resubmits
 * the *entire* slide list, so replaying a stale copy would silently erase a change
 * a co-author made in between. A factory must also re-locate its target by stable
 * identity (a slide's reference, a paragraph's text) rather than by position, since
 * positions shift underneath a concurrent edit.
 *
 * A plain object is correct only for a revision with nothing to re-derive — the raw
 * `__podsBridge` path, where the caller supplies the body verbatim.
 */
export type PodsRevisionSource = Record<string, unknown> | (() => Promise<Record<string, unknown>>);

/**
 * Wrap an already-resolved value so the first attempt reuses it and every later
 * attempt re-resolves. Saves a redundant read on the common single-attempt path
 * without letting a retry reuse stale state.
 */
export const freshAfterFirst = <T>(first: T, resolve: () => Promise<T>): (() => Promise<T>) => {
  let initial: T | undefined = first;
  return async () => {
    if (initial !== undefined) {
      const value = initial;
      initial = undefined;
      return value;
    }
    return resolve();
  };
};

/** A `__podsBridge` directive, validated. */
export interface PodsBridgeParams {
  tabId: number;
  /** Substring selecting the PowerPoint editor OOPIF (e.g. `powerpoint.officeapps.live.com`). */
  frameUrlIncludes: string;
  /** Frame global the pre-script stashes the freshest `/pods` request into, for the auth-header replay. */
  donorGlobal: string;
  /** URL marker the pre-script answers in-frame with `{ head, ts }` — the current co-authoring head. */
  headSentinel: string;
  /** The `{Mode,srs}` revision body (with identity tokens embedded), or a factory re-derived per attempt. */
  body: PodsRevisionSource;
  /** Token standing in for the minted GUID (default {@link DEFAULT_GUID_TOKEN}). */
  guidToken?: string;
  /** Token standing in for the read head (default {@link DEFAULT_HEAD_TOKEN}). */
  headToken?: string;
  /**
   * Preferred source for the current co-authoring head, consulted before the
   * in-frame sentinel on every attempt. The sentinel is fed by the editor's own
   * polls, and a solo idle editor stops polling — freezing the sentinel at a head
   * this engine's own previous write has already superseded, which turns the next
   * write into an accepted-then-dropped no-op. A caller that reads the live model
   * anyway (the action engine does, before every attempt) can supply the head the
   * model response reported instead, which always reflects the current stream.
   * A `null`/empty result falls back to the sentinel.
   */
  headSource?: () => Promise<string | null>;
  /**
   * Replace each write request's `Sequence` with a minted per-write number. The
   * service dedupes on `(session, Sequence)` — a repeat is acknowledged with
   * `StatusCode 0` and silently dropped as a presumed retransmit — so every
   * engine-built write sets this. The raw directive path leaves it off: its
   * callers supply bodies verbatim for byte-precise decode work.
   */
  mintSequence?: boolean;
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
  /** The `ServerError {Code, Source}` pair a rejection carries, when present — the key error-hint lookups use. */
  serverError?: { code?: number; source?: number };
  /** Present only on a write that did not apply — a human-readable reason. */
  failure?: string;
  /**
   * Whether the change was observed in the document after the write. Set only when
   * the caller supplied a {@link PodsWriteConfirmation}. `StatusCode: 0` means the
   * server *accepted* the revision, which is not the same as applying it — a
   * revision the server considers a no-op is accepted and silently dropped. Only
   * `applied: true` proves the document changed.
   */
  applied?: boolean;
  /** How many confirmation reads were issued before the change was observed (or given up on). */
  confirmationReads?: number;
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
 * Read the current co-authoring head: the caller's {@link PodsBridgeParams.headSource}
 * when it yields one, else the editor's in-frame sentinel. The sentinel read is
 * tagged with `donorGlobal` so it targets the exact frame that holds the live
 * session (a nested Office editor has sibling frames on the same host) and fails
 * fast with a clear message when no session is present.
 */
const readHead = async (params: PodsBridgeParams): Promise<string> => {
  if (params.headSource) {
    const sourced = await params.headSource();
    if (typeof sourced === 'string' && sourced.length > 0) return sourced;
  }
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
 * times, each time re-deriving the body, re-reading the now-current head, and
 * minting a fresh GUID — a conflict means the document moved, so replaying the
 * original revision would write against a document that no longer matches it.
 */
export const runPodsBridge = async (params: PodsBridgeParams): Promise<PodsBridgeResult> => {
  const guidToken = params.guidToken ?? DEFAULT_GUID_TOKEN;
  const headToken = params.headToken ?? DEFAULT_HEAD_TOKEN;

  let result: PodsBridgeResult | undefined;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const derived = typeof params.body === 'function' ? await params.body() : params.body;
    // A fresh number per attempt: a conflict retry is a NEW revision (fresh guid,
    // fresh base), so presenting it under the previous attempt's number would
    // make the service drop it as a retransmit.
    const bodyJson = JSON.stringify(params.mintSequence ? withMintedSequence(derived, mintPodsSequence()) : derived);
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
      ...(entry?.ServerError && typeof entry.ServerError === 'object'
        ? {
            serverError: {
              ...(typeof entry.ServerError.Code === 'number' ? { code: entry.ServerError.Code } : {}),
              ...(typeof entry.ServerError.Source === 'number' ? { source: entry.ServerError.Source } : {}),
            },
          }
        : {}),
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

/**
 * How a caller proves a write actually changed the document.
 *
 * `StatusCode: 0` only means the server accepted the revision. A revision the
 * server treats as a no-op — one whose object properties do not match the shape it
 * expects — is accepted and then silently dropped, so judging success on the
 * response alone reports a write that never happened. Confirmation closes that gap
 * by re-reading the document and looking for the change.
 */
export interface PodsWriteConfirmation<TState> {
  /** Re-read the live state the write was meant to change. */
  readState: () => Promise<TState>;
  /** True when `state` shows the intended change. */
  isApplied: (state: TState) => boolean;
  /**
   * Whether re-issuing this exact write is harmless if it turns out to have
   * already applied.
   *
   * This is a safety gate, not a tuning knob. The live read lags the write, so an
   * unconfirmed result is ambiguous: the write may have been dropped, or it may
   * have applied and simply not surfaced yet. Re-issuing an idempotent write
   * (setting bold, setting a size) costs nothing either way. Re-issuing a
   * structural one would act twice — a retried slide delete removes a *second*
   * slide. So a non-idempotent write is never retried on an unconfirmed result; it
   * is reported, and the caller decides.
   */
  idempotent: boolean;
  /** Confirmation reads before concluding the change is not there (default {@link DEFAULT_CONFIRMATION_READS}). */
  reads?: number;
  /** Delay between confirmation reads, ms (default {@link CONFIRMATION_READ_DELAY_MS}). */
  delayMs?: number;
}

/**
 * Confirmation reads issued before a write is declared unapplied. The live model
 * trails an accepted write briefly, so a single immediate read false-negatives.
 */
const DEFAULT_CONFIRMATION_READS = 3;
/** Delay between confirmation reads. Short enough to stay well inside a service-worker turn. */
const CONFIRMATION_READ_DELAY_MS = 400;
/**
 * Extra write attempts for an idempotent write whose change never showed up. One
 * is enough: a write that is accepted twice and still invisible is not a timing
 * problem, and looping would just delay a clear failure.
 */
const MAX_UNCONFIRMED_REWRITES = 1;

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Poll the document until the change appears, or the read budget runs out. Reads
 * immediately first — a fresh editor usually shows the change at once — then backs
 * off. A read that throws counts as "not yet": a transient frame error must not be
 * mistaken for a failed write.
 */
const confirmApplied = async <TState>(
  confirmation: PodsWriteConfirmation<TState>,
): Promise<{ applied: boolean; reads: number }> => {
  const budget = confirmation.reads ?? DEFAULT_CONFIRMATION_READS;
  const gap = confirmation.delayMs ?? CONFIRMATION_READ_DELAY_MS;
  for (let read = 1; read <= budget; read++) {
    if (read > 1) await delay(gap);
    try {
      if (confirmation.isApplied(await confirmation.readState())) return { applied: true, reads: read };
    } catch {
      // Treat a failed read as inconclusive and keep looking.
    }
  }
  return { applied: false, reads: budget };
};

/**
 * Run a pods write and confirm it actually changed the document.
 *
 * Wraps {@link runPodsBridge} — which handles the head read, identity mint, POST,
 * and stale-base retry — with the check the response cannot give: re-read the
 * document and look for the change. An accepted-but-dropped write comes back as a
 * `failure` rather than a false success, so a caller never reports an edit that did
 * not happen.
 *
 * An idempotent write whose change never appears is re-issued once against a fresh
 * head; a structural one is not, for the reason documented on
 * {@link PodsWriteConfirmation.idempotent}.
 */
export const runPodsWriteConfirmed = async <TState>(
  params: PodsBridgeParams,
  confirmation: PodsWriteConfirmation<TState>,
): Promise<PodsBridgeResult> => {
  let last: PodsBridgeResult | undefined;
  for (let attempt = 0; attempt <= MAX_UNCONFIRMED_REWRITES; attempt++) {
    const result = await runPodsBridge(params);
    // A write the server actively refused needs no confirmation — it is already a
    // failure, with a more specific reason than confirmation could produce.
    if (result.failure !== undefined) return result;

    const { applied, reads } = await confirmApplied(confirmation);
    last = { ...result, applied, confirmationReads: reads };
    if (applied) return last;

    if (!confirmation.idempotent) {
      return {
        ...last,
        failure:
          'pods write was accepted (StatusCode 0) but the change is not in the document. It was not retried ' +
          'automatically because re-issuing this write would apply it twice if it did land. Re-read the ' +
          'document before trying again.',
      };
    }
  }
  return {
    ...(last as PodsBridgeResult),
    failure:
      'pods write was accepted (StatusCode 0) but the change never appeared in the document, across ' +
      `${MAX_UNCONFIRMED_REWRITES + 1} attempts.`,
  };
};
