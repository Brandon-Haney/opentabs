/**
 * In-memory presentation sessions (Phase 4).
 *
 * Session batching lets agents open a presentation once, run many edit tools
 * against an in-memory copy, then commit a single upload — turning the
 * 5-15s download/upload penalty per edit into one download + one upload for
 * a whole batch. Optimistic concurrency is enforced at commit time via the
 * Graph `If-Match` header with the eTag captured at open time.
 *
 * This module is a pure state container — no HTTP calls, no dependency on
 * pptx-utils. `pptx-utils` imports these helpers and layers the actual
 * download/upload/etag logic on top.
 *
 * Sessions are keyed by `${driveId}:${itemId}` because item ids alone are
 * not globally unique across drives. They live in adapter IIFE module scope,
 * which means each browser tab has its own session map; sessions do not
 * survive tab reloads or navigations (the IIFE is re-injected) — this is
 * acceptable because sessions are explicitly opened/committed/discarded.
 */

/** An open session holding an in-memory copy of a PPTX file. */
export interface PresentationSession {
  driveId: string;
  itemId: string;
  /** ZIP entries map. Tools mutate this in place via the download/upload shim. */
  entries: Map<string, Uint8Array>;
  /** eTag from the item metadata captured at open time. Used as `If-Match` on commit. */
  etag: string;
  openedAt: number;
  lastAccessedAt: number;
  /** True once any edit tool has called uploadPptx (which short-circuits into the session). */
  dirty: boolean;
}

/** Sessions auto-expire after 10 minutes of inactivity. Purged lazily on access. */
const SESSION_TTL_MS = 10 * 60 * 1000;

const sessions = new Map<string, PresentationSession>();

const sessionKey = (driveId: string, itemId: string): string => `${driveId}:${itemId}`;

const isExpired = (session: PresentationSession, now: number): boolean => now - session.lastAccessedAt > SESSION_TTL_MS;

/**
 * Get a session if it exists and is not expired, updating its lastAccessedAt.
 * Purges the entry if expired. Returns undefined if no session exists.
 */
export const touchSession = (driveId: string, itemId: string): PresentationSession | undefined => {
  const key = sessionKey(driveId, itemId);
  const session = sessions.get(key);
  if (!session) return undefined;
  const now = Date.now();
  if (isExpired(session, now)) {
    sessions.delete(key);
    return undefined;
  }
  session.lastAccessedAt = now;
  return session;
};

/** Lookup a session without updating its lastAccessedAt. Still purges if expired. */
export const peekSession = (driveId: string, itemId: string): PresentationSession | undefined => {
  const key = sessionKey(driveId, itemId);
  const session = sessions.get(key);
  if (!session) return undefined;
  if (isExpired(session, Date.now())) {
    sessions.delete(key);
    return undefined;
  }
  return session;
};

export const storeSession = (session: PresentationSession): void => {
  sessions.set(sessionKey(session.driveId, session.itemId), session);
};

export const deleteSession = (driveId: string, itemId: string): boolean => sessions.delete(sessionKey(driveId, itemId));

/** Enumerate all live sessions, purging expired entries as a side effect. */
export const listSessions = (): PresentationSession[] => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (isExpired(s, now)) sessions.delete(key);
  }
  return Array.from(sessions.values());
};

/** Clear every session. Intended for tests and `discard_all` style tools. */
export const clearAllSessions = (): number => {
  const count = sessions.size;
  sessions.clear();
  return count;
};
