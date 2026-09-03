/**
 * The pods donor interceptor — runs INSIDE the officeapps.live.com editor frame.
 *
 * PowerPoint on the web edits the open deck by POSTing incremental revisions to
 * `/pods/PowerPoint.ashx` into the live co-authoring session — the only channel
 * that can change a file while it is open, since Graph's full-file PUT is
 * refused under the co-authoring lock. Replaying an edit needs that request's
 * live session headers (the WOPI `X-AccessToken`, `X-Key`, `PodSID`, …).
 *
 * This stashes the freshest such request in a global INSIDE the editor frame and
 * nowhere else. It is the security-critical difference from an earlier version:
 * the donor is never postMessaged to the host page, and no host-reachable global
 * is exposed, so the session credentials never cross the frame boundary. The
 * replay (`browser_fetch_in_frame`) reads the donor here and POSTs inside this
 * same frame, exactly as Excel's bridge does.
 *
 * It also reads the current co-authoring head from the editor's polls and serves
 * it back through an in-frame `fetch` sentinel, so a second incremental edit can
 * chain on the live head (see {@link PODS_HEAD_SENTINEL}).
 */

/** Frame-local global the freshest `/pods` request is stashed under. */
export const PODS_DONOR_GLOBAL = '__otbPptPodsDonor';
const PODS_PATH = '/pods/PowerPoint.ashx';
/**
 * URL marker for the head-read channel. An in-frame `fetch` whose URL contains
 * this marker is answered locally with the latest co-authoring head instead of
 * hitting the network — the only way to read the head, which the editor holds
 * client-side and never echoes in a response. Chaining a second incremental edit
 * needs the current head as its `BaseId`; the server rejects a base that a prior
 * edit has already superseded. The value returned is a bare revision id
 * (`<guid>|<counter>`) — no credentials, no document content — and it is
 * reachable only from inside this frame, which can already see far more.
 */
export const PODS_HEAD_SENTINEL = '__otb_pods_head__';
/**
 * URL marker for the last-write read channel. An in-frame `fetch` whose URL
 * contains this marker is answered locally with the most recent type-3 (write)
 * `/pods` request the editor issued — the full `{Mode,srs:[[3,…]]}` revision
 * envelope, captured verbatim. This is the in-frame equivalent of a HAR for a
 * single write: it lets a decode read exactly what the editor's own edit looks
 * like (e.g. how it deletes a slide) without a manual DevTools export. Type-2
 * polls do not overwrite it, so it survives until the editor makes its next write.
 * The record carries the request's url, method, body and time — never its
 * session headers, which stay in the frame-local donor: a decode needs only the
 * body, and the sentinel's answer leaves the frame as a tool result.
 */
export const PODS_LAST_WRITE_SENTINEL = '__otb_pods_lastwrite__';
/**
 * URL marker for the write-log read channel — the ring-buffer form of
 * {@link PODS_LAST_WRITE_SENTINEL}, holding a whole session of edits so a burst
 * of gestures can be decoded together (the single-slot last-write channel keeps
 * only the most recent, silently losing every earlier edit in a batch).
 *
 * It answers in two forms, because one captured write can be hundreds of
 * kilobytes and the reply has to cross the frame boundary as a tool result:
 *
 * - no query → a MANIFEST: `{cap, count, dropped, totalBytes, entries}` where each
 *   entry is `{index, ts, bytes, action, method, url}`, newest first. It carries no
 *   bodies, so it is small enough to always come back whole — the index of what was
 *   captured, with each write's self-declared action name.
 * - `?entry=<index>` → one full {@link PodsWriteRecord}, the body included.
 *
 * Read the manifest first, then pull the entries worth decoding. `dropped` counts
 * writes evicted by either cap, so a burst that outgrew the buffer says so instead
 * of quietly reporting a partial session.
 */
export const PODS_WRITE_LOG_SENTINEL = '__otb_pods_writelog__';
/**
 * How many recent writes the ring buffer retains. Sized for a decode session
 * rather than a single gesture: one UI action can emit several revisions, and the
 * editor interleaves its own autosave writes, so a handful of gestures easily
 * spends a dozen slots.
 */
const WRITE_LOG_CAP = 60;
/**
 * Ceiling on the bytes the ring buffer holds, evicting oldest-first. A single
 * write can be very large (a captured `DuplicateSlide` ran to ~470 KB), so a
 * count-only cap could pin tens of megabytes of strings inside the editor frame.
 */
const WRITE_LOG_MAX_BYTES = 24_000_000;
/**
 * Property id carrying a write's action name on its `ClassId 131140` descriptor
 * object (`"NewSlideWithLayout"`, `"RightTextJustify"`, …). Every write
 * self-labels with it, which is what makes a manifest entry identifiable without
 * its body. Matched textually: the properties travel as a flat `[id, value, …]`
 * array, so the id is followed directly by its quoted value.
 */
const ACTION_NAME_PATTERN = /469780989,"([^"]{1,120})"/;
/**
 * Depth counter `browser.fetchInFrame` raises around a replay it issues into this
 * frame. Our own replayed `/pods` POST goes through this same patched `fetch`/XHR,
 * so without this guard `stashDonor` would re-capture our replay as the freshest
 * donor — drifting it off the editor's real traffic. Skip capture while it is
 * non-zero; honouring it is the convention shared with the EWA bridge.
 */
export const BRIDGE_REPLAY_DEPTH_GLOBAL = '__otbBridgeReplayDepth';
/** Marker making the pods interceptor idempotent under re-injection. */
const PODS_FETCH_MARKER = Symbol.for('opentabs.powerpoint.pods.fetch.patched');
const PODS_XHR_MARKER = Symbol.for('opentabs.powerpoint.pods.xhr.patched');

/** The freshest `/pods` request observed in this frame, for in-frame replay. */
export interface PodsDonor {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  ts: number;
}

/**
 * One write the editor issued, as the last-write and write-log sentinels report
 * it: the request without its session headers, so a decode read never carries
 * the co-authoring credentials out of the frame.
 */
export interface PodsWriteRecord {
  url: string;
  method: string;
  body: string;
  ts: number;
}

/** One write as the write-log manifest describes it: everything but the body. */
export interface PodsWriteLogEntry {
  /** Position in the manifest, newest first. Pass it back as `?entry=<index>`. */
  index: number;
  ts: number;
  bytes: number;
  /** The write's self-declared action name, or null when it carries none. */
  action: string | null;
  method: string;
  url: string;
}

/** The write-log manifest: what was captured, without the bodies. */
export interface PodsWriteLogManifest {
  cap: number;
  count: number;
  /** Writes evicted by either cap since the frame loaded — non-zero means the session outgrew the buffer. */
  dropped: number;
  totalBytes: number;
  entries: PodsWriteLogEntry[];
}

/** True when this frame is PowerPoint's own Office Web Apps editor frame. */
export const isPowerPointEditorFrame = (): boolean => {
  try {
    // Office Web Apps serves each app from `<region>-<app>.officeapps.live.com`
    // (e.g. `usc-powerpoint.officeapps.live.com`). Scope to PowerPoint's host so
    // this interceptor never installs in a sibling app's editor (e.g. Excel's),
    // which shares the officeapps.live.com domain and matches the same frame rule.
    const host = location.hostname.toLowerCase();
    return host.endsWith('officeapps.live.com') && host.includes('powerpoint');
  } catch {
    return false;
  }
};

/** Normalize any `HeadersInit` form into a plain name→value map. */
const headersToRecord = (headers: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      out[name] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const entry of headers as string[][]) {
      if (typeof entry[0] === 'string' && typeof entry[1] === 'string') out[entry[0]] = entry[1];
    }
  } else if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === 'string') out[name] = value;
    }
  }
  return out;
};

/**
 * Wrap `fetch`/`XHR` in the editor frame to keep the freshest `/pods` POST as a
 * frame-local donor. Defensive throughout — a throw here would surface inside
 * the editor, so every path swallows its own error and falls through.
 */
export const installPodsDonorInterceptor = (log: { info(message: string): void }): void => {
  const g = globalThis as {
    fetch: typeof fetch & { [PODS_FETCH_MARKER]?: true };
    XMLHttpRequest: typeof XMLHttpRequest;
    [PODS_DONOR_GLOBAL]?: PodsDonor;
  };

  // The latest co-authoring head, read from the editor's own poll traffic. Kept
  // in closure scope (never a page global) and surfaced only through the read
  // sentinel in the fetch patch below.
  let latestHead: { head: string; ts: number } | null = null;

  // The most recent type-3 (write) request the editor issued, kept so a decode
  // can read exactly what the editor's own edit looks like. Polls (type-2) do not
  // overwrite it. Closure-scoped; surfaced only through the read sentinel below.
  let lastWrite: PodsWriteRecord | null = null;

  // A ring buffer of the last WRITE_LOG_CAP type-3 writes, newest last. A burst of
  // user edits overwrites `lastWrite` down to one; this retains the whole burst so
  // a decode can read them all. Surfaced only through the write-log sentinel below.
  const writeLog: PodsWriteRecord[] = [];
  // Bytes currently held and writes evicted, so the manifest can report an
  // overflowing session instead of silently presenting a partial one.
  let writeLogBytes = 0;
  let droppedWrites = 0;

  /**
   * A type-2 `/pods` request is a poll whose body carries the client's current
   * head as `ExpectedLatestRevisionId`. That is the only place the head appears —
   * a poll *response* omits it when the client is up to date. Capture it as the
   * editor issues each poll.
   */
  const captureHead = (body: string): void => {
    try {
      const parsed = JSON.parse(body) as { srs?: [number, { ExpectedLatestRevisionId?: unknown }][] };
      const sr = parsed.srs?.[0];
      if (sr && sr[0] === 2 && typeof sr[1]?.ExpectedLatestRevisionId === 'string') {
        latestHead = { head: sr[1].ExpectedLatestRevisionId, ts: Date.now() };
      }
    } catch {
      /* non-JSON or unexpected shape — leave the last known head in place */
    }
  };

  /**
   * A type-3 `/pods` request is a write (a `Revisions[]` envelope). Retain the
   * freshest one so a decode can read the editor's own edit; polls (type-2) call
   * this too but only writes are kept. The record omits the request's session
   * headers — they stay in the donor global, which never leaves the frame.
   */
  const captureWrite = (url: string, method: string, body: string): void => {
    try {
      const parsed = JSON.parse(body) as { srs?: [number, unknown][] };
      if (parsed.srs?.[0]?.[0] !== 3) return;
      const write: PodsWriteRecord = { url, method, body, ts: Date.now() };
      lastWrite = write;
      writeLog.push(write);
      writeLogBytes += body.length;
      // Evict oldest-first until within both caps. A single write larger than the
      // byte ceiling is still kept: the buffer never empties itself to satisfy it,
      // because a lone oversized write is exactly what a decode came for.
      while (writeLog.length > WRITE_LOG_CAP || (writeLog.length > 1 && writeLogBytes > WRITE_LOG_MAX_BYTES)) {
        const evicted = writeLog.shift();
        if (evicted === undefined) break;
        writeLogBytes -= evicted.body.length;
        droppedWrites += 1;
      }
    } catch {
      /* non-JSON or unexpected shape — leave the last known write in place */
    }
  };

  /** The manifest of captured writes, newest first — the index, without the bodies. */
  const writeLogManifest = (): PodsWriteLogManifest => ({
    cap: WRITE_LOG_CAP,
    count: writeLog.length,
    dropped: droppedWrites,
    totalBytes: writeLogBytes,
    entries: [...writeLog].reverse().map((write, index) => ({
      index,
      ts: write.ts,
      bytes: write.body.length,
      action: ACTION_NAME_PATTERN.exec(write.body)?.[1] ?? null,
      method: write.method,
      url: write.url,
    })),
  });

  /** One captured write by manifest index (newest first), or null when out of range. */
  const writeLogEntry = (index: number): PodsWriteRecord | null => writeLog[writeLog.length - 1 - index] ?? null;

  const stashDonor = (url: string, method: string, headers: Record<string, string>, body: string): void => {
    // Skip capture while one of our own in-frame replays is in flight, so a
    // replayed POST is never re-captured as the donor (see BRIDGE_REPLAY_DEPTH_GLOBAL).
    if (Number((g as Record<string, unknown>)[BRIDGE_REPLAY_DEPTH_GLOBAL]) > 0) return;
    // The editor opens these XHRs with a URL relative to the pods base (e.g.
    // `open("POST", "PowerPoint.ashx?action=…")`), so the raw argument does not
    // contain the full `/pods/PowerPoint.ashx` path. Resolve against the frame's
    // own URL before matching, and stash the absolute form — a replay needs it.
    let absolute: string;
    try {
      absolute = new URL(url, location.href).href;
    } catch {
      absolute = url;
    }
    if (!absolute.includes(PODS_PATH) || method.toUpperCase() !== 'POST') return;
    g[PODS_DONOR_GLOBAL] = { url: absolute, method, headers, body, ts: Date.now() };
    captureHead(body);
    captureWrite(absolute, method, body);
  };

  if (!g.fetch[PODS_FETCH_MARKER]) {
    const origFetch = g.fetch;
    const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        // Read sentinel: answer an in-frame head-read request locally, before any
        // network. `browser_fetch_in_frame` issues this through the frame's patched
        // `fetch`, so the head never has to cross the frame boundary as raw traffic.
        if (url.includes(PODS_HEAD_SENTINEL)) {
          return new Response(JSON.stringify(latestHead), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // Read sentinel: answer an in-frame write-log request with the manifest of
        // captured writes, or — with `?entry=<index>` — one write in full. Two forms
        // because a whole burst of bodies would not survive the reply size limit,
        // while the manifest always does. Checked before the single last-write
        // sentinel because the two markers are distinct strings.
        if (url.includes(PODS_WRITE_LOG_SENTINEL)) {
          const requested = /[?&]entry=(\d+)/.exec(url);
          const payload = requested ? writeLogEntry(Number(requested[1])) : writeLogManifest();
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // Read sentinel: answer an in-frame last-write-read request with the most
        // recent type-3 write the editor made, so a decode can inspect it locally.
        if (url.includes(PODS_LAST_WRITE_SENTINEL)) {
          return new Response(JSON.stringify(lastWrite), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const headers = headersToRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const body = typeof init?.body === 'string' ? init.body : '';
        stashDonor(url, method, headers, body);
      } catch {
        /* observation only — never disturb the editor's own request */
      }
      return origFetch(input, init);
    };
    (patched as typeof patched & { [PODS_FETCH_MARKER]: true })[PODS_FETCH_MARKER] = true;
    g.fetch = patched as typeof fetch & { [PODS_FETCH_MARKER]?: true };
  }

  const Xhr = g.XMLHttpRequest as typeof XMLHttpRequest & { [k: symbol]: unknown };
  if (!Xhr[PODS_XHR_MARKER]) {
    const origOpen = Xhr.prototype.open;
    const origSetHeader = Xhr.prototype.setRequestHeader;
    const origSend = Xhr.prototype.send;
    const STATE = Symbol('opentabs.powerpoint.pods.xhr.state');
    type XhrState = { url: string; method: string; headers: Record<string, string> };
    type XhrWithState = XMLHttpRequest & { [STATE]?: XhrState };
    type OpenRest = [async?: boolean, username?: string | null, password?: string | null];

    Xhr.prototype.open = function patchedOpen(
      this: XhrWithState,
      method: string,
      url: string | URL,
      ...rest: OpenRest
    ) {
      this[STATE] = { url: typeof url === 'string' ? url : url.href, method, headers: {} };
      const forward = origOpen as (this: XMLHttpRequest, m: string, u: string | URL, ...r: unknown[]) => void;
      return forward.call(this, method, url, ...rest);
    } as typeof Xhr.prototype.open;

    Xhr.prototype.setRequestHeader = function patchedSetHeader(this: XhrWithState, name: string, value: string) {
      if (this[STATE]) this[STATE].headers[name] = value;
      return origSetHeader.call(this, name, value);
    };

    Xhr.prototype.send = function patchedSend(this: XhrWithState, body?: Document | XMLHttpRequestBodyInit | null) {
      const state = this[STATE];
      if (state) {
        try {
          stashDonor(state.url, state.method, state.headers, typeof body === 'string' ? body : '');
        } catch {
          /* observation only */
        }
      }
      return origSend.call(this, body);
    };

    Xhr[PODS_XHR_MARKER] = true;
  }

  log.info('[powerpoint] pods donor + head-read interceptor installed (fetch + XHR)');
};
