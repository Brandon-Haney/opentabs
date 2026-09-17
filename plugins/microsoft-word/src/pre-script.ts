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
 * Word's live write channel is not decoded yet, so unlike the other two this
 * records every request the editor sends that carries a body, whatever the
 * endpoint: the point is to learn what Word's editor talks to, and whether it
 * tunnels its own object model the way Excel's does. Narrow it to the channel
 * once that is known.
 */
const WORD_WRITE_LOG_SENTINEL = '__otb_word_writelog__';
/** Requests the ring buffer retains. */
const WORD_WRITE_LOG_CAP = 200;
/** Ceiling on the bytes the ring buffer holds, evicting oldest-first. */
const WORD_WRITE_LOG_MAX_BYTES = 24_000_000;
/** Markers making the editor-frame interceptor idempotent under re-injection. */
const EDITOR_FETCH_MARKER = Symbol.for('opentabs.microsoft-word.editor.fetch.patched');
const EDITOR_XHR_MARKER = Symbol.for('opentabs.microsoft-word.editor.xhr.patched');

/** One request as the write log holds it: no headers, so no session credentials leave the frame. */
interface WordWriteRecord {
  url: string;
  method: string;
  body: string;
  ts: number;
}

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
  };

  const writeLog: WordWriteRecord[] = [];
  let writeLogBytes = 0;
  let droppedWrites = 0;

  const record = (url: string, method: string, body: string): void => {
    // Reads travel as bodyless GETs; an edit carries its arguments in a body.
    if (body.length === 0) return;
    let absolute: string;
    try {
      absolute = new URL(url, location.href).href;
    } catch {
      absolute = url;
    }
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
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        record(url, method, typeof init?.body === 'string' ? init.body : '');
      } catch {
        /* observation only: never disturb the editor's own request */
      }
      return origFetch(input, init);
    };
    (patched as typeof patched & { [EDITOR_FETCH_MARKER]: true })[EDITOR_FETCH_MARKER] = true;
    g.fetch = patched as typeof fetch & { [EDITOR_FETCH_MARKER]?: true };
  }

  const Xhr = g.XMLHttpRequest as typeof XMLHttpRequest & { [k: symbol]: unknown };
  if (!Xhr[EDITOR_XHR_MARKER]) {
    const origOpen = Xhr.prototype.open;
    const origSend = Xhr.prototype.send;
    const STATE = Symbol('opentabs.microsoft-word.editor.xhr.state');
    type XhrWithState = XMLHttpRequest & { [STATE]?: { url: string; method: string } };
    type XhrOpenRest = [async?: boolean, username?: string | null, password?: string | null];

    Xhr.prototype.open = function patchedOpen(
      this: XhrWithState,
      method: string,
      url: string | URL,
      ...rest: XhrOpenRest
    ) {
      this[STATE] = { url: typeof url === 'string' ? url : url.href, method };
      const forward = origOpen as (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void;
      return forward.call(this, method, url, ...rest);
    } as typeof Xhr.prototype.open;

    Xhr.prototype.send = function patchedSend(this: XhrWithState, body?: Document | XMLHttpRequestBodyInit | null) {
      const state = this[STATE];
      if (state) {
        try {
          record(state.url, state.method, typeof body === 'string' ? body : '');
        } catch {
          /* observation only */
        }
      }
      return origSend.call(this, body ?? null);
    };

    Xhr[EDITOR_XHR_MARKER] = true;
  }

  log.info('[microsoft-word] editor-frame write log installed');
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
