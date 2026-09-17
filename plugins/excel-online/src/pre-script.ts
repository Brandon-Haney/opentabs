import { definePreScript } from '@opentabs-dev/plugin-sdk/pre-script';
import { parseReloadMarker } from './reload-marker-parse.js';
import { decodeJwtClaims } from './token-introspection.js';

/**
 * Pre-script for the Excel Online plugin.
 *
 * Runs at document_start in MAIN world, strictly before any page script, in two
 * frame contexts (see `preScriptFrameMatches` in package.json):
 *
 * 1. The plugin's own tabs (`excel.cloud.microsoft`, `*.sharepoint.com/:x:/...`)
 *    — captures the Microsoft Graph access token the adapter uses. On
 *    SharePoint/OneDrive-hosted workbooks the page never calls Graph itself (it
 *    edits through the cross-origin WOPI canvas) and MSAL stores its token cache
 *    encrypted, so there is no plaintext Graph token in `localStorage`. What the
 *    page does do on load is mint per-resource access tokens by POSTing to the
 *    AAD token endpoint (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`).
 *    This pre-script wraps `fetch`/`XHR`, reads the Graph-scoped token out of
 *    those responses, and stashes it for the adapter via `getPreScriptValue`.
 *
 * 2. The Office Web Apps document frame (`*.officeapps.live.com/...`) — installs
 *    an interceptor that stashes the freshest `EwaInternalWebService` request
 *    (URL, headers, body carrying the live coauth `context`) into a frame global
 *    the platform's frame-bridge engine reads. Hooking here at document_start is
 *    essential: the Office bundle caches native `XMLHttpRequest`/`fetch`
 *    references at load, so a later hook would see nothing.
 *
 * In the plugin's own tabs it also records the Office reload marker
 * (`wdrldr`/`wdrldc`/`wdrldsc` query parameters) before the app can strip
 * it from the URL, so the adapter's `onActivate` can report the reload.
 */

// ---------------------------------------------------------------------------
// EwaInternalWebService donor interceptor (Office Web Apps frame)
// ---------------------------------------------------------------------------

/** Frame global the frame-bridge engine reads the freshest donor request from. */
const EWA_DONOR_GLOBAL = '__otbEwaDonor';
/**
 * Frame global holding the freshest per-session AAD token seen on an EWA request.
 *
 * `Refresh` requires a `userAadToken` — the credential that lets the server
 * re-query an external model on the user's behalf — and rejects the call without
 * one. Excel mints it inside this frame and sends it on no other method, so it
 * is harvested here and read back by the frame-bridge engine's
 * `optionsFromFrameGlobals`. It stays in the frame throughout: it is never
 * posted to the host page, never reaches the adapter, and never appears in a
 * tool result.
 */
const EWA_AAD_TOKEN_GLOBAL = '__otbEwaAadToken';
/** Substring identifying the internal RPC endpoint whose requests we harvest. */
const EWA_URL_MARKER = 'EwaInternalWebService.json/';
/**
 * Frame global the platform's frame-bridge engine raises while it replays a
 * request inside this frame.
 *
 * The replay runs in this same MAIN world and so passes through the interceptor
 * below. Capturing it would make the bridge its own donor: each replay would
 * reuse a context sourced from the previous replay rather than from the app, so
 * a `contextPatch` would persist into later calls and the donor would stop
 * tracking live session state. The name is defined by
 * `BRIDGE_REPLAY_DEPTH_GLOBAL` in the platform's `frame-fetch.ts` and the two
 * must match.
 */
const BRIDGE_REPLAY_DEPTH_GLOBAL = '__otbBridgeReplayDepth';
/**
 * URL marker for the write-log read channel. An in-frame `fetch` whose URL
 * contains it is answered locally, never sent: with no query, a manifest
 * `{cap, count, dropped, totalBytes, entries}` whose entries are
 * `{index, ts, bytes, method, url}`, newest first and without bodies; with
 * `?entry=<index>`, that one request in full. It records every EWA request with a
 * body the workbook itself issues — the method name, path and body, never its
 * session headers or query — so a decode can read exactly what a gesture in the grid sent.
 */
const EWA_WRITE_LOG_SENTINEL = '__otb_ewa_writelog__';
/**
 * Requests the ring buffer retains. EWA interleaves viewport reads with every
 * edit, so a single gesture spends several slots.
 */
const EWA_WRITE_LOG_CAP = 200;
/** Ceiling on the bytes the ring buffer holds, evicting oldest-first. */
const EWA_WRITE_LOG_MAX_BYTES = 24_000_000;
/** Markers making the EWA interceptor idempotent under re-injection. */
const EWA_FETCH_MARKER = Symbol.for('opentabs.excel-online.ewa.fetch.patched');
const EWA_XHR_MARKER = Symbol.for('opentabs.excel-online.ewa.xhr.patched');

/** A captured EWA request, matching the shape the frame-bridge engine expects. */
interface EwaDonor {
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  ts: number;
}

/** One EWA request as the write log holds it: the request without its session headers. */
interface EwaWriteRecord {
  url: string;
  /** The RPC method, the path segment after the endpoint marker. */
  method: string;
  body: string;
  ts: number;
}

/** True when this frame is Excel's own Office Web Apps document frame that hosts the RPC. */
const isExcelEditorFrame = (): boolean => {
  try {
    // Office Web Apps serves each app from `<region>-<app>.officeapps.live.com`
    // (e.g. `usc-excel.officeapps.live.com`). Scope to Excel's host so this
    // interceptor never installs in a sibling app's editor (e.g. PowerPoint's),
    // which shares the officeapps.live.com domain and matches the same frame rule.
    const host = location.hostname.toLowerCase();
    return host.endsWith('officeapps.live.com') && host.includes('excel');
  } catch {
    return false;
  }
};

/** Normalize any `HeadersInit`/object header form into a plain name→value map. */
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

/**
 * Install the EWA donor interceptor in the Office Web Apps frame. Hooks XHR
 * (the transport the Office bundle uses for these calls) and `fetch` for safety,
 * and stashes the freshest request whose URL hits the RPC marker and whose body
 * carries a session `context`. Defensive throughout — never throws into page code.
 */
const installEwaDonorInterceptor = (log: {
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}): void => {
  const g = globalThis as {
    fetch: typeof fetch & { [EWA_FETCH_MARKER]?: true };
    XMLHttpRequest: typeof XMLHttpRequest;
    [EWA_DONOR_GLOBAL]?: EwaDonor;
    [EWA_AAD_TOKEN_GLOBAL]?: string;
    [BRIDGE_REPLAY_DEPTH_GLOBAL]?: number;
  };

  /**
   * Harvest the per-session AAD token an EWA request carries, if it has one.
   * Only a few methods include it, so this is kept separate from the donor: the
   * donor is replaced by every qualifying request, whereas the token must
   * survive until it expires or a fresher one arrives.
   */
  const stashAadToken = (requestBody: string): void => {
    try {
      if (!requestBody.includes('"userAadToken"')) return;
      const parsed = JSON.parse(requestBody) as { userAadToken?: unknown };
      if (typeof parsed.userAadToken === 'string' && parsed.userAadToken.length > 0) {
        g[EWA_AAD_TOKEN_GLOBAL] = parsed.userAadToken;
      }
    } catch {
      /* malformed body — nothing to harvest */
    }
  };

  // A ring buffer of the workbook's own EWA requests, newest last, surfaced only
  // through the write-log sentinel. Bytes held and requests evicted are tracked so
  // the manifest reports a session that outgrew the buffer.
  const writeLog: EwaWriteRecord[] = [];
  let writeLogBytes = 0;
  let droppedWrites = 0;

  const recordWrite = (url: string, requestBody: string): void => {
    // Reads travel as bodyless GETs; every edit is a POST carrying its arguments.
    if (requestBody.length === 0) return;
    const method = url.slice(url.indexOf(EWA_URL_MARKER) + EWA_URL_MARKER.length).split(/[?#]/)[0] ?? '';
    // The query string carries the session context, so only the path is kept.
    writeLog.push({ url: url.split('?')[0] ?? url, method, body: requestBody, ts: Date.now() });
    writeLogBytes += requestBody.length;
    // A lone request larger than the byte ceiling is kept: it is what a decode came for.
    while (writeLog.length > EWA_WRITE_LOG_CAP || (writeLog.length > 1 && writeLogBytes > EWA_WRITE_LOG_MAX_BYTES)) {
      const evicted = writeLog.shift();
      if (evicted === undefined) break;
      writeLogBytes -= evicted.body.length;
      droppedWrites += 1;
    }
  };

  /** The write-log manifest, or one full entry when the URL names `?entry=<index>`. */
  const readWriteLog = (url: string): unknown => {
    const requested = /[?&]entry=(\d+)/.exec(url);
    if (requested) return writeLog[writeLog.length - 1 - Number(requested[1])] ?? null;
    return {
      cap: EWA_WRITE_LOG_CAP,
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

  const stash = (url: string, requestHeaders: Record<string, string>, requestBody: string): void => {
    try {
      if (!url.includes(EWA_URL_MARKER)) return;
      // A request the bridge is replaying is our own, not a sample of what the
      // app does, so nothing is harvested from it — neither the donor nor a
      // token it merely echoes back.
      if ((g[BRIDGE_REPLAY_DEPTH_GLOBAL] ?? 0) > 0) return;
      recordWrite(url, requestBody);
      stashAadToken(requestBody);
      if (!requestBody.includes('"context"')) return;
      g[EWA_DONOR_GLOBAL] = { url, requestHeaders, requestBody, ts: Date.now() };
    } catch {
      /* never throw into page code */
    }
  };

  // --- fetch hook (safety net; the Office bundle primarily uses XHR) ---
  if (!g.fetch[EWA_FETCH_MARKER]) {
    const origFetch = g.fetch;
    const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        // Read sentinel: answered locally so the log never reaches the network.
        if (url.includes(EWA_WRITE_LOG_SENTINEL)) {
          return new Response(JSON.stringify(readWriteLog(url)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes(EWA_URL_MARKER) && init?.method?.toUpperCase() === 'POST') {
          const headers = {
            ...(input instanceof Request ? headersToRecord(input.headers) : {}),
            ...headersToRecord(init?.headers),
          };
          const body = typeof init?.body === 'string' ? init.body : '';
          stash(url, headers, body);
        }
      } catch {
        /* fall through to the real fetch */
      }
      return origFetch(input, init);
    };
    (patchedFetch as typeof patchedFetch & { [EWA_FETCH_MARKER]: true })[EWA_FETCH_MARKER] = true;
    g.fetch = patchedFetch as typeof fetch & { [EWA_FETCH_MARKER]?: true };
  }

  // --- XHR hook (primary path) ---
  const Xhr = g.XMLHttpRequest as typeof XMLHttpRequest & { [EWA_XHR_MARKER]?: true };
  if (!(Xhr as unknown as { [k: symbol]: unknown })[EWA_XHR_MARKER]) {
    const origOpen = Xhr.prototype.open;
    const origSetRequestHeader = Xhr.prototype.setRequestHeader;
    const origSend = Xhr.prototype.send;

    const STATE = Symbol('opentabs.excel-online.ewa.xhr.state');
    interface EwaXhrState {
      url: string;
      headers: Record<string, string>;
    }
    type XhrWithState = XMLHttpRequest & { [STATE]?: EwaXhrState };

    type XhrOpenRest = [async?: boolean, username?: string | null, password?: string | null];
    Xhr.prototype.open = function patchedOpen(
      this: XhrWithState,
      method: string,
      url: string | URL,
      ...rest: XhrOpenRest
    ) {
      this[STATE] = { url: typeof url === 'string' ? url : url.href, headers: {} };
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
      if (state) stash(state.url, state.headers, typeof body === 'string' ? body : '');
      return origSend.call(this, body ?? null);
    };

    (Xhr as unknown as { [k: symbol]: unknown })[EWA_XHR_MARKER] = true;
  }

  log.info('[excel-online] EwaInternalWebService donor interceptor and write log installed');
};

// ---------------------------------------------------------------------------
// Microsoft Graph token capture (plugin host frames)
// ---------------------------------------------------------------------------

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
const FETCH_PATCHED_MARKER = Symbol.for('opentabs.excel-online.fetch.patched');
/** Marker used to make the XHR patch idempotent under re-injection. */
const XHR_PATCHED_MARKER = Symbol.for('opentabs.excel-online.xhr.patched');

/**
 * localStorage key the captured token is mirrored to. MSAL only re-mints a
 * Graph token on a cold load or at refresh time, so warm reloads would
 * otherwise see nothing. Persisting here lets every same-origin tab reuse a
 * captured token for its lifetime. The adapter reads the same key.
 */
const LS_TOKEN_KEY = '__opentabs_excel_graph_token';
/**
 * How long to trust a Graph Bearer token sniffed off a request header when it is
 * not a readable JWT and so carries no expiry of its own.
 */
const OPAQUE_BEARER_TTL_SEC = 600;

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
  // origin — there is no Graph token to capture. Install the RPC donor
  // interceptor instead and return.
  if (isExcelEditorFrame()) {
    installEwaDonorInterceptor(log);
    return;
  }

  // Office may replaceState the reload marker away before the adapter runs;
  // document_start is the one moment it is guaranteed to still be on the URL.
  const reloadMarker = parseReloadMarker(location.search, Date.now());
  if (reloadMarker) {
    set('reloadMarker', reloadMarker);
    log.info('[excel-online] reload marker captured', reloadMarker.reason);
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

  /**
   * Stash a Bearer token sniffed off a Graph request header. The header carries
   * no expiry, so the JWT's own `exp` claim is the token's lifetime; an opaque
   * token is trusted for a short window only.
   */
  const stashBearer = (token: string): void => {
    const exp = decodeJwtClaims(token)?.exp;
    stash(
      token,
      typeof exp === 'number' && Number.isFinite(exp)
        ? Math.floor(exp)
        : Math.floor(Date.now() / 1000) + OPAQUE_BEARER_TTL_SEC,
    );
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
    log.debug(`[excel-online] captured Graph token from AAD token endpoint`);
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
          stashBearer(header.slice('Bearer '.length));
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
    const STATE = Symbol('opentabs.excel-online.xhr.state');
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
            stashBearer(state.bearer.slice('Bearer '.length));
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

  log.info('[excel-online] Graph token interceptor installed (fetch + XHR)');
});
