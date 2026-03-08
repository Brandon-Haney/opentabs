import { LAST_SEEN_URLS_KEY } from './constants.js';

/** In-memory cache of last-seen URLs per plugin. */
let cache: Record<string, string> = {};
let loaded = false;

const ensureLoaded = async (): Promise<void> => {
  if (loaded) return;
  try {
    const data = await chrome.storage.local.get(LAST_SEEN_URLS_KEY);
    const stored = data[LAST_SEEN_URLS_KEY];
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      cache = stored as Record<string, string>;
    }
  } catch {
    // Best-effort — storage may not be available
  }
  loaded = true;
};

export const getLastSeenUrl = async (pluginName: string): Promise<string | undefined> => {
  await ensureLoaded();
  return cache[pluginName];
};

export const setLastSeenUrl = async (pluginName: string, url: string): Promise<void> => {
  await ensureLoaded();
  if (cache[pluginName] === url) return;
  cache[pluginName] = url;
  try {
    await chrome.storage.local.set({ [LAST_SEEN_URLS_KEY]: { ...cache } });
  } catch {
    // Best-effort — storage may not be available
  }
};

export const loadLastSeenUrlsFromStorage = async (): Promise<void> => {
  loaded = false;
  await ensureLoaded();
};

/** Reset in-memory state — exported for testing only. */
export const _resetForTesting = (): void => {
  cache = {};
  loaded = false;
};
