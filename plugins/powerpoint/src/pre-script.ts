import { definePreScript } from '@opentabs-dev/plugin-sdk/pre-script';

/**
 * Pre-script for the PowerPoint plugin.
 *
 * Runs at document_start in MAIN world, strictly before any page script.
 *
 * On SharePoint/OneDrive-hosted presentations (`*.sharepoint.com/:p:/...`) the
 * page edits through the cross-origin WOPI canvas and MSAL stores its token
 * cache encrypted, so there is no plaintext Graph token in `localStorage`. The
 * page does mint per-resource access tokens on load by POSTing to the AAD token
 * endpoint (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`); each
 * response is plaintext JSON with `access_token`, `scope`, and `expires_in`.
 *
 * This wraps both `window.fetch` and `XMLHttpRequest`, captures the Graph-scoped
 * token from those token-endpoint responses, and stashes it for the adapter to
 * read via `getPreScriptValue`. It also captures a `Bearer` token from any
 * direct `graph.microsoft.com` request, covering the standalone
 * `powerpoint.cloud.microsoft` app. Capturing the minted token is
 * format-agnostic: it works regardless of how MSAL keys or encrypts its cache.
 */

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

// --- pods donor interceptor (runs INSIDE the officeapps.live.com editor frame) ---
//
// PowerPoint on the web edits the open deck by POSTing incremental revisions to
// `/pods/PowerPoint.ashx` into the live co-authoring session — the only channel
// that can change a file while it is open, since Graph's full-file PUT is
// refused under the co-authoring lock. Replaying an edit needs that request's
// live session headers (the WOPI `X-AccessToken`, `X-Key`, `PodSID`, …).
//
// This stashes the freshest such request in a global INSIDE the editor frame and
// nowhere else. It is the security-critical difference from an earlier version:
// the donor is never postMessaged to the host page, and no host-reachable global
// is exposed, so the session credentials never cross the frame boundary. The
// replay (`browser_fetch_in_frame`) reads the donor here and POSTs inside this
// same frame, exactly as Excel's bridge does.
//
// It also reads the current co-authoring head from the editor's polls and serves
// it back through an in-frame `fetch` sentinel, so a second incremental edit can
// chain on the live head (see `PODS_HEAD_SENTINEL`).

/** Frame-local global the freshest `/pods` request is stashed under. */
const PODS_DONOR_GLOBAL = '__otbPptPodsDonor';
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
const PODS_HEAD_SENTINEL = '__otb_pods_head__';
/**
 * URL marker for the last-write read channel. An in-frame `fetch` whose URL
 * contains this marker is answered locally with the most recent type-3 (write)
 * `/pods` request the editor issued — the full `{Mode,srs:[[3,…]]}` revision
 * envelope, captured verbatim. This is the in-frame equivalent of a HAR for a
 * single write: it lets a decode read exactly what the editor's own edit looks
 * like (e.g. how it deletes a slide) without a manual DevTools export. Type-2
 * polls do not overwrite it, so it survives until the editor makes its next write.
 * The value is a request the editor already made in this frame; reading it is
 * strictly less powerful than the replay `browser_fetch_in_frame` already allows.
 */
const PODS_LAST_WRITE_SENTINEL = '__otb_pods_lastwrite__';
/**
 * Depth counter `browser.fetchInFrame` raises around a replay it issues into this
 * frame. Our own replayed `/pods` POST goes through this same patched `fetch`/XHR,
 * so without this guard `stashDonor` would re-capture our replay as the freshest
 * donor — drifting it off the editor's real traffic. Skip capture while it is
 * non-zero; honouring it is the convention shared with the EWA bridge.
 */
const BRIDGE_REPLAY_DEPTH_GLOBAL = '__otbBridgeReplayDepth';
/** Marker making the pods interceptor idempotent under re-injection. */
const PODS_FETCH_MARKER = Symbol.for('opentabs.powerpoint.pods.fetch.patched');
const PODS_XHR_MARKER = Symbol.for('opentabs.powerpoint.pods.xhr.patched');

/** The freshest `/pods` request observed in this frame, for in-frame replay. */
interface PodsDonor {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  ts: number;
}

/** True when this frame is PowerPoint's own Office Web Apps editor frame. */
const isPowerPointEditorFrame = (): boolean => {
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
const installPodsDonorInterceptor = (log: { info(message: string): void }): void => {
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
  let lastWrite: PodsDonor | null = null;

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
   * this too but only writes are kept.
   */
  const captureWrite = (url: string, method: string, headers: Record<string, string>, body: string): void => {
    try {
      const parsed = JSON.parse(body) as { srs?: [number, unknown][] };
      if (parsed.srs?.[0]?.[0] === 3) lastWrite = { url, method, headers, body, ts: Date.now() };
    } catch {
      /* non-JSON or unexpected shape — leave the last known write in place */
    }
  };

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
    captureWrite(absolute, method, headers, body);
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

const GRAPH_HOSTNAME = 'graph.microsoft.com';
/**
 * Well-known Microsoft Graph resource app id. Legacy v1 token-endpoint
 * responses may name the audience by this id instead of the
 * `https://graph.microsoft.com` URI.
 */
const GRAPH_RESOURCE_APP_ID = '00000003-0000-0000-c000-000000000000';
const TOKEN_ENDPOINT_HOSTNAME = 'login.microsoftonline.com';
/**
 * AAD token endpoint paths. Matches both:
 *   v2: `/<tenant>/oauth2/v2.0/token`  (MSAL.js 2.x default)
 *   v1: `/<tenant>/oauth2/token`       (MSAL.js 1.x / ADAL.js / legacy SP flows)
 */
const TOKEN_ENDPOINT_PATH = /\/oauth2\/(?:v2\.0\/)?token$/i;
/** Marker used to make the fetch patch idempotent under re-injection. */
const FETCH_PATCHED_MARKER = Symbol.for('opentabs.powerpoint.fetch.patched');
/** Marker used to make the XHR patch idempotent under re-injection. */
const XHR_PATCHED_MARKER = Symbol.for('opentabs.powerpoint.xhr.patched');

/**
 * localStorage key the captured token is mirrored to. MSAL only re-mints a
 * Graph token on a cold load or at refresh time, so warm reloads would
 * otherwise see nothing. Persisting here lets every same-origin tab reuse a
 * captured token for its lifetime. The adapter reads the same key.
 */
const LS_TOKEN_KEY = '__opentabs_powerpoint_graph_token';

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
  // The editor frame carries the co-authoring protocol but no MSAL or Graph
  // traffic, so it runs only the pods donor interceptor and nothing else.
  if (isPowerPointEditorFrame()) {
    installPodsDonorInterceptor(log);
    return;
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

  /**
   * Whether a v1 `resource` claim names Microsoft Graph. Legacy `/oauth2/token`
   * responses omit `scope` and identify the audience with a single `resource`
   * value — either the `https://graph.microsoft.com` URI or the Graph app id.
   */
  const resourceGrantsGraph = (resource: string): boolean => {
    const host = parseUrl(resource)?.hostname.toLowerCase();
    return host ? host === GRAPH_HOSTNAME : resource === GRAPH_RESOURCE_APP_ID;
  };

  /** Parse an AAD token-endpoint JSON response and stash any Graph-scoped token. */
  const captureFromTokenResponse = (body: unknown): void => {
    if (!body || typeof body !== 'object') return;
    const data = body as { access_token?: string; scope?: string; resource?: string; expires_in?: number };
    if (typeof data.access_token !== 'string') return;
    // v2 responses carry a space-separated `scope`; legacy v1 (`/oauth2/token`)
    // responses omit it and name the audience in `resource` instead.
    const grantsGraph =
      (typeof data.scope === 'string' && scopeGrantsGraph(data.scope)) ||
      (typeof data.resource === 'string' && resourceGrantsGraph(data.resource));
    if (!grantsGraph) return;
    const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    stash(data.access_token, exp);
    log.debug(`[powerpoint] captured Graph token from AAD token endpoint`);
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
    const STATE = Symbol('opentabs.powerpoint.xhr.state');
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

  log.info('[powerpoint] Graph token interceptor installed (fetch + XHR)');
});
