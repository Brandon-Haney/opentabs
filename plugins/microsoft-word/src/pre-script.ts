import { definePreScript } from '@opentabs-dev/plugin-sdk/pre-script';
import { parseReloadMarker } from './reload-marker-parse.js';

/**
 * Pre-script for the Microsoft Word plugin.
 *
 * Runs at document_start in MAIN world, strictly before any page script.
 *
 * On SharePoint/OneDrive-hosted documents (`*.sharepoint.com/:w:/...`) the page
 * edits through the cross-origin WOPI canvas and MSAL stores its token cache
 * encrypted, so there is no plaintext Graph token to read from `localStorage`.
 * What the page does on load is mint per-resource access tokens by POSTing to
 * the AAD token endpoint (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`);
 * each response is plaintext JSON with `access_token`, `scope`, and `expires_in`.
 *
 * This wraps both `window.fetch` and `XMLHttpRequest`, captures the Graph-scoped
 * token from those token-endpoint responses, and stashes it for the adapter to
 * read via `getPreScriptValue`. It also captures a `Bearer` token from any
 * direct `graph.microsoft.com` request, covering the standalone
 * `word.cloud.microsoft` app. Capturing the minted token is format-agnostic: it
 * works regardless of how MSAL keys or encrypts its cache.
 *
 * It also records the Office reload marker (`wdrldr`/`wdrldc`/`wdrldsc` query
 * parameters) under `reloadMarker`. Office may strip those parameters via
 * `history.replaceState` before the adapter is injected, so document_start is
 * the only reliable moment to read them; the adapter reports the marker from
 * `onActivate`.
 */

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

const GRAPH_HOSTNAME = 'graph.microsoft.com';
const TOKEN_ENDPOINT_HOSTNAME = 'login.microsoftonline.com';
/**
 * AAD token endpoint paths. Matches both:
 *   v2: `/<tenant>/oauth2/v2.0/token`  (MSAL.js 2.x default)
 *   v1: `/<tenant>/oauth2/token`       (MSAL.js 1.x / ADAL.js / legacy SP flows)
 */
const TOKEN_ENDPOINT_PATH = /\/oauth2\/(?:v2\.0\/)?token$/i;
/** Marker used to make the fetch patch idempotent under re-injection. */
const FETCH_PATCHED_MARKER = Symbol.for('opentabs.microsoft-word.fetch.patched');
/** Marker used to make the XHR patch idempotent under re-injection. */
const XHR_PATCHED_MARKER = Symbol.for('opentabs.microsoft-word.xhr.patched');

/**
 * localStorage key the captured token is mirrored to. MSAL only re-mints a
 * Graph token on a cold load or at refresh time, so warm reloads would
 * otherwise see nothing. Persisting here lets every same-origin tab reuse a
 * captured token for its lifetime. The adapter reads the same key.
 */
const LS_TOKEN_KEY = '__opentabs_word_graph_token';

// ---------------------------------------------------------------------------
// Editor-frame discovery log (Office Web Apps frame)
// ---------------------------------------------------------------------------

/**
 * URL marker for the write-log read channel, the counterpart of PowerPoint's
 * `__otb_pods_writelog__` and Excel's `__otb_ewa_writelog__`. An in-frame
 * `fetch` whose URL contains it is answered locally, never sent: with no query a
 * manifest `{cap, count, dropped, totalBytes, entries}` of
 * `{index, ts, bytes, method, url}`, newest first and without bodies; with
 * `?entry=<index>`, that one request in full.
 *
 * Word's live channel turned out to be the same Cobalt revision protocol
 * PowerPoint uses — `/we/OneNote.ashx` carries `{Mode, srs:[[3, {Revision:
 * {ObjectGroups…}}]]}` for a write and `[[2, …]]` for a poll, with the same
 * object classes and property ids — so the log is scoped to that endpoint.
 */
const WORD_WRITE_LOG_SENTINEL = '__otb_word_writelog__';
/**
 * URL marker for the head-read channel. An in-frame `fetch` whose URL contains
 * it is answered with the latest co-authoring head, which the editor holds
 * client-side and sends on its polls but no response echoes. Chaining an edit
 * onto the live document needs it as the revision to build on. The answer also
 * describes the stashed donor, so a replay that finds none can say why.
 */
const WORD_HEAD_SENTINEL = '__otb_word_head__';
/**
 * URL marker for the model-read channel, answered with the most recent channel
 * *response*. A write has to name the objects it edits and append itself to the
 * container's child list, and the only place the document's current object
 * model appears is in what the server sends back — the request log holds the
 * other half of the conversation. One response is kept rather than a log of
 * them, because the model is large and only the newest is meaningful.
 */
const WORD_MODEL_SENTINEL = '__otb_word_model__';
/** Ceiling on the retained response; a larger one is kept as its head, which carries the object groups. */
const WORD_MODEL_MAX_BYTES = 4_000_000;
/**
 * Longest property value the digest keeps. The model is mostly bulk — access
 * tokens, theme palettes, embedded XML — around a thin layer of structure, so a
 * digest that keeps every property but truncates each one is a fraction of the
 * size and loses nothing about how the document is shaped.
 */
const DIGEST_VALUE_MAX = 120;
/** Frame-local global the freshest `/we/OneNote.ashx` request is stashed under. */
const WORD_DONOR_GLOBAL = '__otbWordDonor';
/** Path of the co-authoring channel, named for the app that first used the protocol. */
const WORD_CHANNEL_PATH = '/we/OneNote.ashx';
/** Requests the ring buffer retains. */
const WORD_WRITE_LOG_CAP = 200;
/** Ceiling on the bytes the ring buffer holds, evicting oldest-first. */
const WORD_WRITE_LOG_MAX_BYTES = 24_000_000;
/** Markers making the editor-frame interceptor idempotent under re-injection. */
const EDITOR_FETCH_MARKER = Symbol.for('opentabs.microsoft-word.editor.fetch.patched');
const EDITOR_XHR_MARKER = Symbol.for('opentabs.microsoft-word.editor.xhr.patched');

/**
 * One request as the write log holds it. Headers are dropped, but Word's own
 * channel carries a WOPI access token inside the body, so a record is not
 * credential-free: it is diagnostic material, readable only through the
 * in-frame sentinel, and belongs nowhere else.
 */
interface WordWriteRecord {
  url: string;
  method: string;
  body: string;
  ts: number;
}

/**
 * The freshest channel request, for an in-frame replay. It keeps the session
 * headers, so unlike a log record it never leaves the frame: the frame-bridge
 * engine reads this global inside the frame and posts from there.
 */
interface WordDonor {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  ts: number;
}

/** Normalize any `HeadersInit` form into a plain name-value map. */
const headersToRecord = (headers: unknown): Record<string, string> => {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      record[name] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers as string[][]) {
      if (typeof entry[0] === 'string' && typeof entry[1] === 'string') record[entry[0]] = entry[1];
    }
    return record;
  }
  if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === 'string') record[name] = value;
    }
  }
  return record;
};

/** True when this frame is Word's own Office Web Apps editor frame. */
const isWordEditorFrame = (): boolean => {
  try {
    // Office Web Apps serves each app from `<region>-<app>.officeapps.live.com`
    // (e.g. `usc-word.officeapps.live.com`). Scope to Word's host so this never
    // installs in a sibling app's editor, which shares the domain.
    const host = location.hostname.toLowerCase();
    return host.endsWith('officeapps.live.com') && host.includes('word');
  } catch {
    return false;
  }
};

/**
 * Record every bodied request the Word editor issues, and answer the read
 * sentinel locally. Defensive throughout: never throws into page code.
 */
const installWordEditorLog = (log: { info(message: string, ...args: unknown[]): void }): void => {
  const g = globalThis as {
    fetch: typeof fetch & { [EDITOR_FETCH_MARKER]?: true };
    XMLHttpRequest: typeof XMLHttpRequest;
    [WORD_DONOR_GLOBAL]?: WordDonor;
  };

  const writeLog: WordWriteRecord[] = [];
  let writeLogBytes = 0;
  let droppedWrites = 0;
  // The latest co-authoring head, read from the editor's own polls. Closure
  // scoped, surfaced only through the read sentinel below.
  let latestHead: { head: string; ts: number } | null = null;

  /**
   * A poll (`srs[0][0] === 2`) carries the client's current head as
   * `ExpectedLatestRevisionId`. That is the only place it appears: a poll
   * response omits it when the client is already up to date.
   */
  const captureHead = (body: string): void => {
    try {
      const parsed = JSON.parse(body) as {
        srs?: [number, { ExpectedLatestRevisionId?: unknown }][];
      };
      const sr = parsed.srs?.[0];
      if (sr && sr[0] === 2 && typeof sr[1]?.ExpectedLatestRevisionId === 'string') {
        latestHead = { head: sr[1].ExpectedLatestRevisionId, ts: Date.now() };
      }
    } catch {
      /* non-JSON or unexpected shape — leave the last known head in place */
    }
  };

  const record = (url: string, method: string, body: string): void => {
    // Reads travel as bodyless GETs; an edit carries its arguments in a body.
    if (body.length === 0) return;
    // The editor opens these with a URL relative to the channel, so the path is
    // only visible once it is resolved against the frame — filtering on the raw
    // argument matched nothing.
    let absolute: string;
    try {
      absolute = new URL(url, location.href).href;
    } catch {
      absolute = url;
    }
    if (!absolute.includes(WORD_CHANNEL_PATH)) return;
    captureHead(body);
    // The query string carries session context, so only the path is kept.
    writeLog.push({ url: absolute.split('?')[0] ?? absolute, method, body, ts: Date.now() });
    writeLogBytes += body.length;
    while (writeLog.length > WORD_WRITE_LOG_CAP || (writeLog.length > 1 && writeLogBytes > WORD_WRITE_LOG_MAX_BYTES)) {
      const evicted = writeLog.shift();
      if (evicted === undefined) break;
      writeLogBytes -= evicted.body.length;
      droppedWrites += 1;
    }
  };

  /** The manifest, or one full entry when the URL names `?entry=<index>`. */
  const readWriteLog = (url: string): unknown => {
    const requested = /[?&]entry=(\d+)/.exec(url);
    if (requested) return writeLog[writeLog.length - 1 - Number(requested[1])] ?? null;
    return {
      cap: WORD_WRITE_LOG_CAP,
      count: writeLog.length,
      dropped: droppedWrites,
      totalBytes: writeLogBytes,
      entries: [...writeLog].reverse().map((write, index) => ({
        index,
        ts: write.ts,
        bytes: write.body.length,
        method: write.method,
        url: write.url,
      })),
    };
  };

  /**
   * Keep the freshest channel request for a replay. The editor opens these with
   * a URL relative to the channel, so it is resolved against the frame before
   * matching and stashed absolute — a replay needs the whole URL.
   */
  const stashDonor = (url: string, method: string, headers: Record<string, string>, body: string): void => {
    try {
      let absolute: string;
      try {
        absolute = new URL(url, location.href).href;
      } catch {
        absolute = url;
      }
      if (!absolute.includes(WORD_CHANNEL_PATH) || method.toUpperCase() !== 'POST' || body.length === 0) return;
      g[WORD_DONOR_GLOBAL] = { url: absolute, method, headers, body, ts: Date.now() };
    } catch {
      /* observation only */
    }
  };

  /**
   * What is known about the stashed donor, for diagnosis. Header *names* say
   * whether the session credentials were captured; their values stay in the
   * frame, so nothing here can authenticate a request.
   */
  /** The newest channel response, holding the document's current object model. */
  let latestModel: { ts: number; bytes: number; truncated: boolean; body: string } | null = null;

  /**
   * Keep a channel response, trimmed to a bound so a large model cannot pin
   * memory. Only a response carrying `ObjectGroups` is kept: the server answers
   * most polls with a bare ack, and the model arrives once when the document
   * loads, so keeping literally the newest response would discard it within
   * seconds of the editor opening.
   */
  const recordResponse = (absolute: string, text: string): void => {
    if (!absolute.includes(WORD_CHANNEL_PATH) || text.length === 0) return;
    if (!text.includes('"ObjectGroups"')) return;
    latestModel = {
      ts: Date.now(),
      bytes: text.length,
      truncated: text.length > WORD_MODEL_MAX_BYTES,
      body: text.slice(0, WORD_MODEL_MAX_BYTES),
    };
  };

  /**
   * The model reduced to its structure: every object with its class, id and
   * properties, each value truncated, plus a count per class. Reducing it here
   * rather than after it leaves the frame keeps a large model readable.
   */
  const digestModel = (): unknown => {
    if (!latestModel) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(latestModel.body);
    } catch {
      return { ts: latestModel.ts, bytes: latestModel.bytes, error: 'response did not parse as JSON' };
    }

    // `Objects` arrays sit several envelopes deep and in more than one place
    // (one per cell), so collect them wherever they appear.
    const objects: { ClassId?: unknown; ObjectId?: unknown; Properties?: unknown }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'Objects' && Array.isArray(value)) objects.push(...value);
        else walk(value);
      }
    };
    walk(parsed);

    const shorten = (value: unknown): string => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (typeof text !== 'string') return String(value);
      return text.length > DIGEST_VALUE_MAX ? `${text.slice(0, DIGEST_VALUE_MAX)}…+${text.length}` : text;
    };

    const classCounts: Record<string, number> = {};
    const rows = objects.map(object => {
      const classId = String(object.ClassId);
      classCounts[classId] = (classCounts[classId] ?? 0) + 1;
      const props: Record<string, string> = {};
      // Properties travel as a flat [id, value, id, value, …] pair list.
      if (Array.isArray(object.Properties)) {
        for (let i = 0; i + 1 < object.Properties.length; i += 2) {
          props[String(object.Properties[i])] = shorten(object.Properties[i + 1]);
        }
      }
      return { classId: object.ClassId, objectId: object.ObjectId, props };
    });

    return { ts: latestModel.ts, bytes: latestModel.bytes, objectCount: rows.length, classCounts, objects: rows };
  };

  const describeDonor = (): unknown => {
    const donor = g[WORD_DONOR_GLOBAL];
    if (!donor) return null;
    return { ts: donor.ts, bytes: donor.body.length, headerNames: Object.keys(donor.headers).sort() };
  };

  if (!g.fetch[EDITOR_FETCH_MARKER]) {
    const origFetch = g.fetch;
    const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes(WORD_WRITE_LOG_SENTINEL)) {
          return new Response(JSON.stringify(readWriteLog(url)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes(WORD_HEAD_SENTINEL)) {
          return new Response(JSON.stringify({ ...latestHead, donor: describeDonor() }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes(WORD_MODEL_SENTINEL)) {
          return new Response(JSON.stringify(url.includes('digest') ? digestModel() : latestModel), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const body = typeof init?.body === 'string' ? init.body : '';
        record(url, method, body);
        stashDonor(
          url,
          method,
          headersToRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
          body,
        );
      } catch {
        /* observation only: never disturb the editor's own request */
      }
      const response = await origFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        const absolute = new URL(url, location.href).href;
        if (absolute.includes(WORD_CHANNEL_PATH)) {
          // Read the copy, so the editor still gets an unconsumed body.
          void response
            .clone()
            .text()
            .then(text => recordResponse(absolute, text))
            .catch(() => {});
        }
      } catch {
        /* observation only */
      }
      return response;
    };
    (patched as typeof patched & { [EDITOR_FETCH_MARKER]: true })[EDITOR_FETCH_MARKER] = true;
    g.fetch = patched as typeof fetch & { [EDITOR_FETCH_MARKER]?: true };
  }

  const Xhr = g.XMLHttpRequest as typeof XMLHttpRequest & { [k: symbol]: unknown };
  if (!Xhr[EDITOR_XHR_MARKER]) {
    const origOpen = Xhr.prototype.open;
    const origSend = Xhr.prototype.send;
    const origSetRequestHeader = Xhr.prototype.setRequestHeader;
    const STATE = Symbol('opentabs.microsoft-word.editor.xhr.state');
    type XhrWithState = XMLHttpRequest & { [STATE]?: { url: string; method: string; headers: Record<string, string> } };
    type XhrOpenRest = [async?: boolean, username?: string | null, password?: string | null];

    Xhr.prototype.open = function patchedOpen(
      this: XhrWithState,
      method: string,
      url: string | URL,
      ...rest: XhrOpenRest
    ) {
      this[STATE] = { url: typeof url === 'string' ? url : url.href, method, headers: {} };
      const forward = origOpen as (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void;
      return forward.call(this, method, url, ...rest);
    } as typeof Xhr.prototype.open;

    Xhr.prototype.setRequestHeader = function patchedSetRequestHeader(this: XhrWithState, name: string, value: string) {
      const state = this[STATE];
      if (state) state.headers[name] = value;
      return origSetRequestHeader.call(this, name, value);
    };

    Xhr.prototype.send = function patchedSend(this: XhrWithState, body?: Document | XMLHttpRequestBodyInit | null) {
      const state = this[STATE];
      if (state) {
        try {
          const text = typeof body === 'string' ? body : '';
          record(state.url, state.method, text);
          stashDonor(state.url, state.method, state.headers, text);
          this.addEventListener('load', () => {
            try {
              recordResponse(new URL(state.url, location.href).href, this.responseText);
            } catch {
              /* a non-text responseType throws on access — nothing to keep */
            }
          });
        } catch {
          /* observation only */
        }
      }
      return origSend.call(this, body ?? null);
    };

    Xhr[EDITOR_XHR_MARKER] = true;
  }

  log.info('[microsoft-word] editor-frame write log and donor installed');
};

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const isGraphUrl = (url: string): boolean => parseUrl(url)?.hostname.toLowerCase() === GRAPH_HOSTNAME;

const isTokenEndpointUrl = (url: string): boolean => {
  const u = parseUrl(url);
  return !!u && u.hostname.toLowerCase() === TOKEN_ENDPOINT_HOSTNAME && TOKEN_ENDPOINT_PATH.test(u.pathname);
};

definePreScript(({ set, log }) => {
  // In the Office Web Apps document frame the page is not the plugin's own
  // origin, so there is no Graph token to capture. Record what the editor sends
  // instead, so its live channel can be decoded.
  if (isWordEditorFrame()) {
    installWordEditorLog(log);
    return;
  }

  const reloadMarker = parseReloadMarker(location.search, Date.now());
  if (reloadMarker) {
    set('reloadMarker', reloadMarker);
    log.info('[microsoft-word] reload marker captured', reloadMarker.reason);
  }

  const g = globalThis as {
    fetch: typeof fetch & { [FETCH_PATCHED_MARKER]?: true };
    XMLHttpRequest: typeof XMLHttpRequest & { [XHR_PATCHED_MARKER]?: true };
  };

  const stash = (token: string, exp: number): void => {
    if (!token || token.length < 16) return;
    set('graph', { token, exp } satisfies CapturedGraphToken);
    set('graphCapturedAt', Date.now());
    try {
      localStorage.setItem(LS_TOKEN_KEY, JSON.stringify({ token, exp } satisfies CapturedGraphToken));
    } catch {
      /* storage unavailable — the in-page namespace still works for this load */
    }
  };

  const extractBearer = (headers: HeadersInit | undefined): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get('Authorization') ?? headers.get('authorization') ?? undefined;
    }
    if (Array.isArray(headers)) {
      for (const entry of headers as string[][]) {
        if (entry[0]?.toLowerCase() === 'authorization') return entry[1];
      }
      return undefined;
    }
    if (headers && typeof headers === 'object') {
      const h = headers as Record<string, string>;
      return h.Authorization ?? h.authorization;
    }
    return undefined;
  };

  /**
   * Whether the AAD `scope` claim grants Microsoft Graph. The claim is a
   * space-separated list of scope identifiers (some are URIs), e.g.
   * `https://graph.microsoft.com/Files.Read.All openid profile`. We split and
   * exact-match the hostname rather than substring-match the whole claim.
   */
  const scopeGrantsGraph = (scope: string): boolean =>
    scope.split(/\s+/).some(s => parseUrl(s)?.hostname.toLowerCase() === GRAPH_HOSTNAME);

  /** Parse an AAD token-endpoint JSON response and stash any Graph-scoped token. */
  const captureFromTokenResponse = (body: unknown): void => {
    if (!body || typeof body !== 'object') return;
    const data = body as { access_token?: string; scope?: string; expires_in?: number };
    if (typeof data.access_token !== 'string' || typeof data.scope !== 'string') return;
    if (!scopeGrantsGraph(data.scope)) return;
    const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    stash(data.access_token, exp);
    log.debug(`[microsoft-word] captured Graph token from AAD token endpoint`);
  };

  // --- fetch patch (primary path for MSAL.js auth-code flow + direct Graph) ---

  // Idempotency: a second injection into the same realm (hot reload, future
  // iframe-reuse) must not stack wrappers — that would recurse and double-stash.
  if (!g.fetch[FETCH_PATCHED_MARKER]) {
    const origFetch = g.fetch;
    const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

      // Secondary path: a Bearer header on a direct Graph request.
      if (isGraphUrl(url)) {
        const header =
          extractBearer(init?.headers) ?? (input instanceof Request ? extractBearer(input.headers) : undefined);
        if (header?.startsWith('Bearer ') && header.length > 'Bearer '.length) {
          // No expiry available from a request header; trust it for a short window.
          stash(header.slice('Bearer '.length), Math.floor(Date.now() / 1000) + 600);
        }
      }

      const response = await origFetch(input, init);

      // Primary path: parse the AAD token-endpoint response for a Graph token.
      if (isTokenEndpointUrl(url)) {
        response
          .clone()
          .json()
          .then(captureFromTokenResponse)
          .catch(() => {
            /* non-JSON or read failure — ignore */
          });
      }

      return response;
    };

    (patchedFetch as typeof patchedFetch & { [FETCH_PATCHED_MARKER]: true })[FETCH_PATCHED_MARKER] = true;
    g.fetch = patchedFetch as typeof fetch & { [FETCH_PATCHED_MARKER]?: true };
  }

  // --- XMLHttpRequest patch ---
  //
  // SharePoint's WAC/Owl framework uses XHR for AAD silent-refresh calls on
  // some flows (MSAL.js exposes an XHR client for legacy compatibility, and
  // SP wraps it). Without this hook, refreshed tokens never reach our stash
  // and the LS mirror goes stale after the first hour.

  if (!g.XMLHttpRequest.prototype || !(g.XMLHttpRequest as unknown as { [k: symbol]: unknown })[XHR_PATCHED_MARKER]) {
    const Xhr = g.XMLHttpRequest;
    const origOpen = Xhr.prototype.open;
    const origSetRequestHeader = Xhr.prototype.setRequestHeader;

    // Per-instance state stashed under a Symbol so we don't collide with page code.
    const STATE = Symbol('opentabs.microsoft-word.xhr.state');
    type XhrState = { url: string; bearer?: string };
    type XhrWithState = XMLHttpRequest & { [STATE]?: XhrState };

    // The XHR.open spec is variadic — `(method, url, async?, user?, password?)`.
    // The rest tuple here covers the optional tail of the longer overload so
    // we can forward every form without falling back to `arguments`.
    type XhrOpenRest = [async?: boolean, username?: string | null, password?: string | null];
    const patchedOpen = function patchedOpen(
      this: XhrWithState,
      method: string,
      url: string | URL,
      ...rest: XhrOpenRest
    ) {
      const urlStr = typeof url === 'string' ? url : url.href;
      this[STATE] = { url: urlStr };
      // `once` is essential: XHR instances are reusable, and we add a listener
      // on every `open()`. Without it, a reused instance would accumulate a
      // listener per request and re-run capture for every prior request on each
      // subsequent response. With it, each request gets exactly one fire.
      this.addEventListener(
        'load',
        () => {
          const state = this[STATE];
          if (!state) return;

          // Secondary path: outbound Graph request carrying a Bearer header.
          if (isGraphUrl(state.url) && state.bearer?.startsWith('Bearer ')) {
            stash(state.bearer.slice('Bearer '.length), Math.floor(Date.now() / 1000) + 600);
          }

          // Primary path: AAD token-endpoint response body.
          if (isTokenEndpointUrl(state.url)) {
            try {
              const text = this.responseText;
              if (text) captureFromTokenResponse(JSON.parse(text));
            } catch {
              /* non-JSON or restricted responseText — ignore */
            }
          }
        },
        { once: true },
      );
      // The two `open` overloads (with/without async/user/password) don't
      // unify when forwarding a rest tuple, so widen `origOpen` to a single
      // signature that accepts unknown trailing args.
      const forward = origOpen as (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void;
      return forward.call(this, method, urlStr, ...rest);
    };
    Xhr.prototype.open = patchedOpen as typeof Xhr.prototype.open;

    Xhr.prototype.setRequestHeader = function patchedSetRequestHeader(this: XhrWithState, name: string, value: string) {
      if (name.toLowerCase() === 'authorization' && this[STATE]) {
        this[STATE].bearer = value;
      }
      return origSetRequestHeader.call(this, name, value);
    };

    (g.XMLHttpRequest as unknown as { [k: symbol]: unknown })[XHR_PATCHED_MARKER] = true;
  }

  log.info('[microsoft-word] Graph token interceptor installed (fetch + XHR)');
});
