import { definePreScript } from '@opentabs-dev/plugin-sdk/pre-script';

/**
 * Pre-script for the Microsoft Word plugin.
 *
 * Runs at document_start in MAIN world, strictly before any page script.
 *
 * On SharePoint/OneDrive-hosted documents (`*.sharepoint.com/:w:/...`) the page
 * edits through the cross-origin WOPI canvas and MSAL stores its token cache
 * encrypted, so there is no plaintext Graph token to read from `localStorage`.
 * What the page does on load is mint per-resource access tokens by POSTing to
 * the AAD token endpoint (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`)
 * via `fetch`; each response is plaintext JSON with `access_token`, `scope`, and
 * `expires_in`.
 *
 * This wraps `window.fetch`, captures the Graph-scoped token from those
 * token-endpoint responses, and stashes it for the adapter to read via
 * `getPreScriptValue`. It also captures a `Bearer` token from any direct
 * `graph.microsoft.com` request, covering the standalone `word.cloud.microsoft`
 * app.
 */

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

const TOKEN_ENDPOINT = /login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token/i;
const GRAPH_HOST = /(^|\/\/|\.)graph\.microsoft\.com(\/|$)/i;

/** localStorage mirror so warm reloads and same-origin tabs reuse a captured token. */
const LS_TOKEN_KEY = '__opentabs_word_graph_token';

definePreScript(({ set, log }) => {
  const g = globalThis as { fetch: typeof fetch };
  const origFetch = g.fetch;

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

  const captureFromTokenResponse = (body: unknown): void => {
    if (!body || typeof body !== 'object') return;
    const data = body as { access_token?: string; scope?: string; expires_in?: number };
    if (typeof data.access_token !== 'string' || typeof data.scope !== 'string') return;
    if (!GRAPH_HOST.test(data.scope)) return;
    const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    stash(data.access_token, Math.floor(Date.now() / 1000) + ttl);
    log.debug(`[microsoft-word] captured Graph token from AAD token endpoint`);
  };

  const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    if (GRAPH_HOST.test(url)) {
      const header = extractBearer(init?.headers) ?? (input instanceof Request ? extractBearer(input.headers) : undefined);
      if (header?.startsWith('Bearer ') && header.length > 'Bearer '.length) {
        stash(header.slice('Bearer '.length), Math.floor(Date.now() / 1000) + 600);
      }
    }

    const response = await origFetch(input, init);

    if (TOKEN_ENDPOINT.test(url)) {
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

  g.fetch = patchedFetch;
  log.info('[microsoft-word] Graph token interceptor installed');
});
