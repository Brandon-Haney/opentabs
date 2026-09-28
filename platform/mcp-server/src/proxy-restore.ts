/**
 * Session restoration between the dev proxy and its worker.
 *
 * When the dev proxy restarts its worker, the new worker has no MCP sessions.
 * The proxy restores each client's session by replaying the client's original
 * `initialize` against the new worker. That replay is not a new client, so it
 * must not spend the worker's new-session rate limit — otherwise a reload with
 * more sessions than the limit allows drops the excess, and their clients then
 * compete for a budget the restoration already used up.
 *
 * The proxy proves a request is its own restoration with a random token it
 * generates per run and hands to the worker through the environment. Clients
 * never see the token, and the proxy strips the header from everything it
 * forwards, so a client cannot claim the exemption. Outside the dev proxy the
 * environment variable is unset and no request is ever exempt.
 */

import { timingSafeEqual } from 'node:crypto';

/** Request header carrying the proxy's restore token. */
export const PROXY_RESTORE_HEADER = 'x-opentabs-proxy-restore';

/** Environment variable through which the proxy passes the token to its worker. */
export const PROXY_RESTORE_TOKEN_ENV = 'OPENTABS_PROXY_RESTORE_TOKEN';

/** Whether a request carries this run's proxy restore token. */
export const isProxyRestoreRequest = (headers: Headers): boolean => {
  const expected = process.env[PROXY_RESTORE_TOKEN_ENV];
  const presented = headers.get(PROXY_RESTORE_HEADER);
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
