import { PLUGINS_META_KEY } from './constants.js';
import type { PluginMeta } from './extension-messages.js';

/**
 * Write-through in-memory cache of plugin metadata.
 * Populated on first read, kept in sync on every write.
 * Avoids redundant async chrome.storage.local reads on hot paths
 * (tabs.onUpdated, tab state checks).
 */
let metaCache: Record<string, PluginMeta> | null = null;

/** Serializes all write operations to prevent concurrent read-modify-write races. */
let writeMutex = Promise.resolve();

const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = writeMutex.then(fn);
  writeMutex = result.then(
    () => {},
    () => {},
  );
  return result;
};

/**
 * Store a batch of plugins in a single chrome.storage.local.set() call.
 * Builds the full meta index in memory and writes the meta index atomically.
 */
const storePluginsBatch = (metas: PluginMeta[]): Promise<void> =>
  serialize(async () => {
    if (metas.length === 0) return;
    const index = await getAllPluginMeta();

    for (const meta of metas) {
      index[meta.name] = meta;
    }

    await chrome.storage.local.set({ [PLUGINS_META_KEY]: index });
    metaCache = index;
  });

const removePlugin = (pluginName: string): Promise<void> =>
  serialize(async () => {
    const index = await getAllPluginMeta();
    if (!(pluginName in index)) return;
    const { [pluginName]: _, ...rest } = index;
    await chrome.storage.local.set({ [PLUGINS_META_KEY]: rest });
    metaCache = rest;
  });

/**
 * Remove multiple plugins in a single batched operation.
 * Reads the meta index once, removes all named plugins, then writes the
 * updated index in one call.
 */
const removePluginsBatch = (pluginNames: string[]): Promise<void> =>
  serialize(async () => {
    if (pluginNames.length === 0) return;
    const index = await getAllPluginMeta();
    const removeSet = new Set(pluginNames);
    const filtered: Record<string, PluginMeta> = {};
    for (const [name, meta] of Object.entries(index)) {
      if (!removeSet.has(name)) {
        filtered[name] = meta;
      }
    }
    await chrome.storage.local.set({ [PLUGINS_META_KEY]: filtered });
    metaCache = filtered;
  });

const VALID_TRUST_TIERS = new Set<string>(['official', 'community', 'local']);

const isValidPluginMeta = (value: unknown): value is PluginMeta => {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.version === 'string' &&
    Array.isArray(obj.urlPatterns) &&
    typeof obj.trustTier === 'string' &&
    VALID_TRUST_TIERS.has(obj.trustTier) &&
    Array.isArray(obj.tools)
  );
};

const getAllPluginMeta = async (): Promise<Record<string, PluginMeta>> => {
  if (metaCache !== null) {
    return { ...metaCache };
  }

  const data = await chrome.storage.local.get(PLUGINS_META_KEY);
  const index = data[PLUGINS_META_KEY];
  if (!index || typeof index !== 'object') {
    metaCache = {};
    return {};
  }

  const validated: Record<string, PluginMeta> = {};
  for (const [key, value] of Object.entries(index as Record<string, unknown>)) {
    if (isValidPluginMeta(value)) {
      validated[key] = value;
    } else {
      console.warn(`[opentabs] Skipping corrupted plugin meta entry: ${key}`);
    }
  }
  metaCache = validated;
  return { ...validated };
};

const getPluginMeta = async (pluginName: string): Promise<PluginMeta | undefined> => {
  const index = await getAllPluginMeta();
  return index[pluginName];
};

/** Invalidate the in-memory cache, forcing the next read to hit chrome.storage.local. */
const invalidatePluginCache = (): void => {
  metaCache = null;
};

export { storePluginsBatch, removePlugin, removePluginsBatch, getAllPluginMeta, getPluginMeta, invalidatePluginCache };
