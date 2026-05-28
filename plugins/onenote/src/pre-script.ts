import { definePreScript } from '@opentabs-dev/plugin-sdk/pre-script';

/**
 * Pre-script for the OneNote plugin.
 *
 * Runs at document_start in MAIN world, strictly before any page script.
 *
 * On the standalone `onenote.cloud.microsoft` app, plaintext MSAL Graph tokens
 * are read from `localStorage` by the adapter. SharePoint/OneDrive-hosted
 * notebooks (`*.sharepoint.com/:o:/...` and `Doc.aspx`) keep the MSAL cache
 * encrypted instead, so we wrap `window.fetch` and capture the Graph token from
 * the AAD token-endpoint response (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`),
 * stashing it for the adapter to read via `getPreScriptValue`. We also capture
 * any `Bearer` token on a direct `graph.microsoft.com` request, which covers
 * the standalone app's later refresh path.
 *
 * Note: the SharePoint OneNote page never mints a Notes-scoped Graph token (the
 * SharePoint shell app is not consented for `Notes.*`). The captured token has
 * Files/Sites scopes; `onenote-api` filters it out for the OneNote Graph API
 * and points callers at `read_current_page` (which works token-free).
 */

interface CapturedGraphToken {
  token: string;
  /** Unix epoch seconds. */
  exp: number;
}

const TOKEN_ENDPOINT = /login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token/i;
const GRAPH_HOST = /(^|\/\/|\.)graph\.microsoft\.com(\/|$)/i;

/** localStorage mirror so warm reloads and same-origin tabs reuse a captured token. */
const LS_TOKEN_KEY = '__opentabs_onenote_graph_token';

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
  };

  const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    if (GRAPH_HOST.test(url)) {
      const header =
        extractBearer(init?.headers) ?? (input instanceof Request ? extractBearer(input.headers) : undefined);
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
  log.info('[onenote] Graph token interceptor installed');
});
