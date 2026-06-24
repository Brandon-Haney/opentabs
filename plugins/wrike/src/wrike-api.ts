import { ToolError, getCookie, parseRetryAfterMs, waitUntil } from '@opentabs-dev/plugin-sdk';

// Wrike's documented REST API (/api/v4) requires an OAuth bearer token and
// rejects the logged-in web session. The web app itself talks to an internal
// RPC layer under /ui/ that authenticates with the session cookies plus two
// headers, so the plugin uses that same surface.
const UI_BASE = 'https://www.wrike.com/ui';

// Any non-empty value satisfies the server — it only checks for the header's
// presence, not its contents. A web-style id keeps requests indistinguishable
// from the app's own traffic.
const CLIENT_ID = `web-${Math.random().toString(16).slice(2, 18)}`;

// --- Auth detection ---
// The account id identifies which Wrike account the request targets. The active
// account is encoded in the workspace URL (?acc=<id>); the `account` cookie is a
// fallback. Logged-in state is signalled by the non-HttpOnly `uid` cookie.

export const getAccountId = (): string | null => {
  const fromUrl = new URLSearchParams(window.location.search).get('acc');
  if (fromUrl) return fromUrl;
  return getCookie('account');
};

export const getCurrentUserId = (): string | null => getCookie('uid');

export const isAuthenticated = (): boolean => getAccountId() !== null && getCurrentUserId() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

// --- RPC caller ---

interface RpcEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  errorDescription?: string;
}

/**
 * Calls an internal Wrike /ui RPC endpoint. All endpoints are POST + JSON and
 * return a `{ success, data }` envelope. Returns the unwrapped `data` payload.
 */
export const rpc = async <T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> =>
  request<T>(endpoint, 'application/json', JSON.stringify(body));

/**
 * Calls a /ui RPC endpoint with a form-encoded body. A few write endpoints
 * (e.g. stream_add_comment) expect `application/x-www-form-urlencoded` rather
 * than JSON. Returns the unwrapped `data` payload.
 */
export const rpcForm = async <T>(endpoint: string, fields: Record<string, string>): Promise<T> =>
  request<T>(endpoint, 'application/x-www-form-urlencoded', new URLSearchParams(fields).toString());

/**
 * Updates one or more properties on a work item via the generic property-edit
 * endpoint. `propertiesToUpdate` is keyed by stable property id (e.g. "-4" for
 * status, "-2" for assignees). The entity typeId for a work item is always -2.
 */
export const editTaskProperty = <T>(
  taskId: number,
  propertiesToUpdate: Record<string, unknown>,
  visibleComponents: string[],
): Promise<T> =>
  rpc<T>('work_item_view_edit_property_value', {
    entityModification: { id: taskId, typeId: -2, propertiesToUpdate },
    visibleComponents,
  });

export interface ContainerSaveResult {
  id?: number | string;
  title?: string;
}

/**
 * Creates a folder or project inside a parent folder/project. Wrike models both
 * as the same entity distinguished by the `project` system field, so they share
 * one save path. The new container is shared with the current user so it is
 * visible to them; one created inside a shared parent otherwise inherits its
 * sharing.
 */
export const saveContainer = (
  title: string,
  parentFolderId: number,
  options: { project: boolean },
): Promise<ContainerSaveResult> => {
  const data: Record<string, unknown> = {
    accountId: getAccountId(),
    title,
    parentFoldersAdd: [parentFolderId],
    systemFieldsAdd: { project: options.project, isSpace: false, pinnedView: 'tableV2' },
    createFolder: true,
  };
  const currentUserId = getCurrentUserId();
  if (currentUserId) data.sharedsAdd = [currentUserId];
  return rpc<ContainerSaveResult>('task_save', { data });
};

const request = async <T>(endpoint: string, contentType: string, body: string): Promise<T> => {
  const accountId = getAccountId();
  if (!accountId) throw ToolError.auth('Not authenticated — please log in to Wrike.');

  const url = `${UI_BASE}/${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'x-w-account': accountId,
    'wrike-client-id': CLIENT_ID,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw ToolError.timeout(`Wrike request timed out: ${endpoint}`);
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw ToolError.timeout('Request was aborted');
    }
    throw new ToolError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'network_error', {
      category: 'internal',
      retryable: true,
    });
  }

  if (!response.ok) {
    const errorBody = (await response.text().catch(() => '')).substring(0, 512);

    // The session token expired (417 SESSION_EXPIRED) or the request was not
    // recognised as authenticated (401 not_authorized) — both are auth errors.
    if (response.status === 417 || response.status === 401 || response.status === 403) {
      throw ToolError.auth(`Wrike session expired — please reload the page. (${response.status}) ${errorBody}`);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
      throw ToolError.rateLimited(`Rate limited: ${endpoint} — ${errorBody}`, retryMs);
    }
    if (response.status === 404) throw ToolError.notFound(`Not found: ${endpoint} — ${errorBody}`);
    if (response.status === 400 || response.status === 422) {
      throw ToolError.validation(`Validation error: ${endpoint} — ${errorBody}`);
    }
    throw ToolError.internal(`Wrike API error (${response.status}): ${endpoint} — ${errorBody}`);
  }

  let envelope: RpcEnvelope<T>;
  try {
    envelope = (await response.json()) as RpcEnvelope<T>;
  } catch {
    throw ToolError.internal(`Wrike returned a non-JSON response: ${endpoint}`);
  }

  if (envelope.success === false) {
    const message = envelope.errorDescription ?? envelope.error ?? 'unknown error';
    if (envelope.error === 'not_authorized') throw ToolError.auth(`Not authorized: ${message}`);
    throw ToolError.internal(`Wrike API error: ${endpoint} — ${message}`);
  }

  return (envelope.data ?? ({} as T)) as T;
};
