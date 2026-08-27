import {
  ToolError,
  buildQueryString,
  getAuthCache,
  getPageGlobal,
  httpStatusToToolError,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

const AUTH_NAMESPACE = 'servicenow';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_LENGTH = 500;

/** Session token ServiceNow exposes as the `g_ck` page global and accepts as the `X-UserToken` header. */
interface ServiceNowAuth {
  token: string;
}

/**
 * Reads the session token, preferring the cached value.
 *
 * The cache is seeded from the page global on first use and is thereafter kept current by
 * `refreshTokenFrom` whenever the instance issues a replacement. A long-lived tab holds a
 * `g_ck` that the instance has already rotated away from, so the cache — not the page global —
 * is the authoritative copy once a request has been made.
 */
const getToken = (): string | null => {
  const cached = getAuthCache<ServiceNowAuth>(AUTH_NAMESPACE);
  if (cached?.token) return cached.token;

  const pageToken = getPageGlobal('g_ck');
  if (typeof pageToken !== 'string' || pageToken.length === 0) return null;

  setAuthCache<ServiceNowAuth>(AUTH_NAMESPACE, { token: pageToken });
  return pageToken;
};

/** Stores a replacement token issued by the instance. */
const cacheToken = (token: string): void => {
  setAuthCache<ServiceNowAuth>(AUTH_NAMESPACE, { token });
};

export const isAuthenticated = (): boolean => getToken() !== null;

export const waitForAuth = async (): Promise<boolean> => {
  try {
    await waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Issues one request against the instance.
 *
 * `X-UserToken` is always sent, even when the cached token is known to be stale. ServiceNow
 * answers a token-bearing request with an empty `WWW-Authenticate` header, but answers a
 * request with no token at all with `WWW-Authenticate: Basic` — which the browser renders as a
 * native sign-in dialog that blocks every subsequent interaction with the tab. Omitting the
 * header is therefore never an acceptable fallback.
 */
const send = (path: string, token: string, timeout: number): Promise<Response> =>
  fetch(path, {
    credentials: 'include',
    headers: { Accept: 'application/json', 'X-UserToken': token },
    signal: AbortSignal.timeout(timeout),
  });

/**
 * Performs an authenticated read against the instance, recovering from token rotation.
 *
 * A rejected request carries a replacement token in `X-UserToken-Response`; the request is
 * retried once with it. `fetchFromPage` cannot serve this path because it discards the
 * response — and with it the replacement token — before the caller can read the headers.
 */
const request = async (path: string, timeout = REQUEST_TIMEOUT_MS): Promise<Response> => {
  const token = getToken();
  if (!token) throw ToolError.auth('Not signed in to ServiceNow — open the instance in a tab and sign in.');

  let response: Response;
  try {
    response = await send(path, token, timeout);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw ToolError.timeout(`ServiceNow request timed out after ${timeout}ms — try narrowing the query.`);
    }
    throw ToolError.internal(`ServiceNow request failed for ${path}: ${String(error)}`);
  }

  if (response.status === 401) {
    const replacement = response.headers.get('x-usertoken-response');
    if (replacement && replacement !== token) {
      cacheToken(replacement);
      response = await send(path, replacement, timeout);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    const detail = body.length > MAX_ERROR_BODY_LENGTH ? `${body.slice(0, MAX_ERROR_BODY_LENGTH)}…` : body;
    throw httpStatusToToolError(response, `ServiceNow returned HTTP ${response.status} for ${path}: ${detail}`);
  }

  return response;
};

/** A page of table records plus the total number of rows matching the query. */
export interface TablePage<T> {
  records: T[];
  total: number;
}

/** Query parameters accepted by the Table API. */
export interface TableQuery {
  /** Encoded query string (ServiceNow `sysparm_query` syntax). */
  query?: string;
  /** Comma-separated field list to return. */
  fields?: string;
  limit?: number;
  offset?: number;
}

/**
 * Reads records from a table.
 *
 * Every read requests `sysparm_display_value=all`, so each field arrives as a
 * `{ display_value, value, link? }` object. Mappers depend on that single, uniform shape.
 */
export const tableQuery = async <T>(table: string, params: TableQuery = {}): Promise<TablePage<T>> => {
  const qs = buildQueryString({
    sysparm_query: params.query,
    sysparm_fields: params.fields,
    sysparm_limit: params.limit,
    sysparm_offset: params.offset,
    sysparm_display_value: 'all',
    sysparm_exclude_reference_link: true,
  });

  const response = await request(`/api/now/table/${table}?${qs}`);
  const total = Number(response.headers.get('x-total-count') ?? '0');
  const body = (await response.json()) as { result?: T[] };

  return { records: body.result ?? [], total: Number.isNaN(total) ? 0 : total };
};

/** Reads a single record by sys_id, or null when it does not exist or is hidden by an access rule. */
export const tableGet = async <T>(table: string, sysId: string, fields?: string): Promise<T | null> => {
  const page = await tableQuery<T>(table, { query: `sys_id=${sysId}`, fields, limit: 1 });
  return page.records[0] ?? null;
};

/** One aggregate bucket returned by the stats API. */
export interface StatsBucket {
  stats?: { count?: string };
  groupby_fields?: { field?: string; value?: string }[];
}

/** Counts records, optionally grouped by a field. */
export const statsQuery = async (table: string, query: string, groupBy?: string): Promise<StatsBucket[]> => {
  const qs = buildQueryString({
    sysparm_count: true,
    sysparm_query: query,
    sysparm_group_by: groupBy,
    sysparm_display_value: true,
  });

  const response = await request(`/api/now/stats/${table}?${qs}`);
  const body = (await response.json()) as { result?: StatsBucket | StatsBucket[] };
  const result = body.result;

  if (!result) return [];
  return Array.isArray(result) ? result : [result];
};

/** A selectable value on a choice field. */
export interface RawChoice {
  label?: string;
  value?: string;
}

/** Column metadata as returned by the UI metadata endpoint. */
export interface RawColumn {
  label?: string;
  name?: string;
  type?: string;
  internal_type?: string;
  reference?: string;
  mandatory?: boolean;
  read_only?: boolean;
  max_length?: number;
  hint?: string;
  choices?: RawChoice[];
}

/**
 * Reads column metadata and choice lists for a table.
 *
 * This is the readable source for choice labels — the `sys_choice` table is commonly withheld
 * by access rules even from users who can read the records those choices describe.
 */
export const tableMeta = async (table: string): Promise<Record<string, RawColumn>> => {
  const response = await request(`/api/now/ui/meta/${table}`);
  const body = (await response.json()) as { result?: { columns?: Record<string, RawColumn> } };
  return body.result?.columns ?? {};
};

/** The signed-in user, as reported by the instance. */
export interface RawCurrentUser {
  user_sys_id?: string;
  user_name?: string;
  user_display_name?: string;
  user_initials?: string;
}

export const currentUser = async (): Promise<RawCurrentUser> => {
  const response = await request('/api/now/ui/user/current_user');
  const body = (await response.json()) as { result?: RawCurrentUser };
  return body.result ?? {};
};

/** Resolves the sys_id of the signed-in user, for queries scoped to "my" records. */
export const currentUserSysId = async (): Promise<string> => {
  const user = await currentUser();
  if (!user.user_sys_id) throw ToolError.auth('Could not resolve the signed-in ServiceNow user.');
  return user.user_sys_id;
};

/** Resolves the group sys_ids the signed-in user belongs to. */
export const currentUserGroupIds = async (): Promise<string[]> => {
  const userSysId = await currentUserSysId();
  const page = await tableQuery<{ group?: { value?: string } }>('sys_user_grmember', {
    query: `user=${userSysId}`,
    fields: 'group',
    limit: 200,
  });

  return page.records.map(record => record.group?.value ?? '').filter(id => id.length > 0);
};
