import type { ConfigStateBrowserTool, ConfigStateFailedPlugin, ConfigStatePlugin } from '@opentabs-dev/shared';

/**
 * In-memory cache of server-owned state. This mirrors the shape of
 * ConfigStateResult from @opentabs-dev/shared so there is no translation
 * layer when serving data to the side panel.
 *
 * The cache is populated from sync.full and plugins.changed push notifications.
 * It is cleared on WebSocket disconnect and rebuilt from scratch on the next
 * sync.full. The in-memory cache is the primary read path (instant). Every
 * mutation writes through to chrome.storage.session (debounced 500ms) so
 * the cache survives MV3 service worker suspension.
 */
interface ServerStateCache {
  plugins: ConfigStatePlugin[];
  failedPlugins: ConfigStateFailedPlugin[];
  browserTools: ConfigStateBrowserTool[];
  serverVersion?: string;
}

const SESSION_KEY = 'serverStateCache';
const CACHES_INITIALIZED_KEY = 'cachesInitialized';

const EMPTY_CACHE: ServerStateCache = {
  plugins: [],
  failedPlugins: [],
  browserTools: [],
  serverVersion: undefined,
};

let cache: ServerStateCache = { ...EMPTY_CACHE };

/**
 * Tracks whether sync.full has populated the caches at least once in the
 * current WebSocket session. Distinguishes "service worker woke from
 * suspension" (cachesInitialized=true, caches empty) from "WebSocket just
 * connected but sync.full has not arrived yet" (cachesInitialized=false,
 * caches empty). Persisted to chrome.storage.session so it survives
 * MV3 service worker suspension.
 */
let cachesInitialized = false;

/** Debounce timer for session storage writes. */
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Write the current in-memory cache to chrome.storage.session. */
const persistToSession = (): void => {
  chrome.storage.session.set({ [SESSION_KEY]: cache, [CACHES_INITIALIZED_KEY]: cachesInitialized }).catch(() => {
    // Best-effort persistence — session storage may not be available
  });
};

/** Schedule a debounced write to session storage (500ms). */
const schedulePersist = (): void => {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    persistToSession();
  }, 500);
};

/** Return the current server state cache (read-only snapshot). */
const getServerStateCache = (): Readonly<ServerStateCache> => cache;

/**
 * Merge a partial update into the server state cache. Only the provided
 * fields are overwritten — omitted fields retain their previous values.
 * The in-memory cache updates immediately; session storage write is debounced.
 */
const updateServerStateCache = (partial: Partial<ServerStateCache>): void => {
  cache = { ...cache, ...partial };
  schedulePersist();
};

/**
 * Write the current in-memory cache to chrome.storage.session immediately,
 * cancelling any pending debounced write. Called after sync.full populates
 * the cache to ensure critical state survives MV3 service worker suspension
 * without waiting for the 500ms debounce window.
 */
const flushServerStateCacheToSession = (): void => {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  persistToSession();
};

/**
 * Clear the server state cache. Called on WebSocket disconnect so the
 * next connection rebuilds state from sync.full without stale data.
 * Clears both in-memory cache and chrome.storage.session.
 */
const clearServerStateCache = (): void => {
  cache = { ...EMPTY_CACHE };
  cachesInitialized = false;
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  chrome.storage.session.remove([SESSION_KEY, CACHES_INITIALIZED_KEY]).catch(() => {
    // Best-effort removal
  });
};

/**
 * Load the server state cache from chrome.storage.session and populate the
 * in-memory cache. Called on service worker wake to restore state that was
 * persisted before suspension.
 */
const loadServerStateCacheFromSession = async (): Promise<void> => {
  try {
    const data = await chrome.storage.session.get([SESSION_KEY, CACHES_INITIALIZED_KEY]);
    const stored = data[SESSION_KEY] as ServerStateCache | undefined;
    if (stored && typeof stored === 'object') {
      cache = {
        plugins: Array.isArray(stored.plugins) ? stored.plugins : [],
        failedPlugins: Array.isArray(stored.failedPlugins) ? stored.failedPlugins : [],
        browserTools: Array.isArray(stored.browserTools) ? stored.browserTools : [],
        serverVersion: typeof stored.serverVersion === 'string' ? stored.serverVersion : undefined,
      };
    }
    if (typeof data[CACHES_INITIALIZED_KEY] === 'boolean') {
      cachesInitialized = data[CACHES_INITIALIZED_KEY];
    }
  } catch {
    // Session storage may not be available — keep empty cache
  }
};

/** Returns whether sync.full has populated the caches in the current session. */
const getCachesInitialized = (): boolean => cachesInitialized;

/** Mark caches as initialized after sync.full populates them. */
const setCachesInitialized = (value: boolean): void => {
  cachesInitialized = value;
};

export {
  clearServerStateCache,
  flushServerStateCacheToSession,
  getCachesInitialized,
  getServerStateCache,
  loadServerStateCacheFromSession,
  setCachesInitialized,
  updateServerStateCache,
};
export type { ServerStateCache };
