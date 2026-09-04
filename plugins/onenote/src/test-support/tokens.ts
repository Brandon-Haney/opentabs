// ---------------------------------------------------------------------------
// Test fixtures for the token sources onenote-api reads: JWT-shaped Graph
// tokens and the storage shapes of the pre-script namespace, its localStorage
// mirror, and the standalone app's MSAL cache. Test-only — excluded from dist.
// ---------------------------------------------------------------------------

/** MSAL client id of the OneNote web app, matching onenote-api's MSAL_CLIENT_ID. */
export const MSAL_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';

/** localStorage key the pre-script mirrors its captured token to, matching onenote-api's LS_TOKEN_KEY. */
export const LS_MIRROR_KEY = '__opentabs_onenote_graph_token';

/** An MSAL access-token cache key whose target lists Graph scopes, so onenote-api's key scan selects it. */
const MSAL_GRAPH_ENTRY_KEY = `uid.utid-login.windows.net-accesstoken-${MSAL_CLIENT_ID}-tenant-https://graph.microsoft.com/notes.readwrite openid profile`;

export interface GraphTokenClaims {
  scp?: string;
  aud?: string;
}

const base64Url = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A structurally valid, unsigned JWT carrying `claims` in its payload segment. */
export const makeGraphToken = (claims: GraphTokenClaims): string =>
  `${base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64Url(JSON.stringify(claims))}.signature`;

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Writes an MSAL cache entry for `token`; `expiresOn` (epoch seconds) is omitted from the entry when undefined. */
export const installMsalToken = (token: string, expiresOn?: number): void => {
  localStorage.setItem(`msal.token.keys.${MSAL_CLIENT_ID}`, JSON.stringify({ accessToken: [MSAL_GRAPH_ENTRY_KEY] }));
  localStorage.setItem(
    MSAL_GRAPH_ENTRY_KEY,
    JSON.stringify({ secret: token, ...(expiresOn !== undefined && { expiresOn: String(expiresOn) }) }),
  );
};

interface OpenTabsGlobal {
  __openTabs?: { _pluginName?: string; preScript?: Record<string, Record<string, unknown>> };
}

/** Stashes `token` where the pre-script would, with the plugin name bound as the adapter binds it during dispatch. */
export const installPreScriptToken = (token: string, exp: number): void => {
  (globalThis as OpenTabsGlobal).__openTabs = {
    _pluginName: 'onenote',
    preScript: { onenote: { graph: { token, exp } } },
  };
};

/** Writes the pre-script's localStorage mirror entry for `token`. */
export const installMirrorToken = (token: string, exp: number): void => {
  localStorage.setItem(LS_MIRROR_KEY, JSON.stringify({ token, exp }));
};

/** Removes every token source so each test starts unauthenticated. */
export const clearTokenSources = (): void => {
  localStorage.clear();
  delete (globalThis as OpenTabsGlobal).__openTabs;
};
