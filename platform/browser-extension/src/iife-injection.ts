import { getAllPluginMeta } from './plugin-storage.js';
import { urlMatchesPatterns } from './tab-matching.js';

/** Matches the NAME_REGEX from @opentabs-dev/shared — duplicated here as defense-in-depth */
const SAFE_PLUGIN_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Names reserved for platform use — rejected at the injection layer as defense-in-depth */
const RESERVED_NAMES = new Set(['system', 'browser', 'opentabs', 'extension', 'config', 'plugin', 'tool', 'mcp']);

const isSafePluginName = (name: string): boolean => SAFE_PLUGIN_NAME.test(name) && !RESERVED_NAMES.has(name);

/** Check if an adapter for the given plugin is already injected in a tab */
const isAdapterPresent = async (tabId: number, pluginName: string): Promise<boolean> => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (pName: string) => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.[pName] !== undefined;
      },
      args: [pluginName],
    });
    const first = results[0] as { result?: unknown } | undefined;
    return first?.result === true;
  } catch (err) {
    console.warn(`[opentabs] isAdapterPresent failed for tab ${String(tabId)}, plugin ${pluginName}:`, err);
    return false;
  }
};

/**
 * Verify that the injected adapter reports the expected version.
 * Logs a warning on mismatch — does not throw, so the injection pipeline
 * continues for other tabs/plugins.
 */
const verifyAdapterVersion = async (tabId: number, pluginName: string, expectedVersion: string): Promise<void> => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (pName: string) => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, { version?: string }> }
          | undefined;
        return ot?.adapters?.[pName]?.version;
      },
      args: [pluginName],
    });
    const first = results[0] as { result?: unknown } | undefined;
    const version = first?.result;
    if (version !== expectedVersion) {
      console.warn(
        `[opentabs] Adapter version mismatch for ${pluginName}: expected ${expectedVersion}, got ${String(version)}`,
      );
    }
  } catch {
    console.warn(`[opentabs] Failed to verify adapter version for ${pluginName}`);
  }
};

/** Read the adapter hash from the page for a given plugin. Returns undefined on failure. */
const readAdapterHash = async (tabId: number, pluginName: string): Promise<string | undefined> => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (pName: string) => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, { __adapterHash?: string }> }
          | undefined;
        return ot?.adapters?.[pName]?.__adapterHash;
      },
      args: [pluginName],
    });
    const first = results[0] as { result?: unknown } | undefined;
    return typeof first?.result === 'string' ? first.result : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Verify that the injected adapter's content hash matches the expected hash.
 * Returns true if hashes match, false otherwise. Does not throw.
 */
const verifyAdapterHash = async (tabId: number, pluginName: string, expectedHash: string): Promise<boolean> => {
  const hash = await readAdapterHash(tabId, pluginName);
  return hash === expectedHash;
};

/**
 * Inject an adapter file into a single tab via chrome.scripting.executeScript.
 *
 * Uses the `files` option to inject the pre-built adapter IIFE from the
 * extension's adapters/ directory. This bypasses all page CSP restrictions
 * because file-based injection is not subject to page CSP.
 */
const injectAdapterFile = async (
  tabId: number,
  pluginName: string,
  version?: string,
  adapterHash?: string,
): Promise<void> => {
  const adapterFile = `adapters/${pluginName}.js`;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: [adapterFile],
    });
  } catch (err) {
    throw new Error(
      `Failed to inject adapter file '${adapterFile}' into tab ${String(tabId)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (version) {
    await verifyAdapterVersion(tabId, pluginName, version);
  }

  if (adapterHash) {
    const hashMatched = await verifyAdapterHash(tabId, pluginName, adapterHash);
    if (!hashMatched) {
      // Retry once after a short delay — the file may have been partially written
      await new Promise(resolve => setTimeout(resolve, 200));
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: [adapterFile],
        });
      } catch (err) {
        throw new Error(
          `Failed to re-inject adapter file '${adapterFile}' into tab ${String(tabId)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (version) {
        await verifyAdapterVersion(tabId, pluginName, version);
      }

      const retryMatched = await verifyAdapterHash(tabId, pluginName, adapterHash);
      if (!retryMatched) {
        const actualHash = await readAdapterHash(tabId, pluginName);
        console.warn(
          `[opentabs] Adapter hash mismatch for ${pluginName} after retry: expected ${adapterHash}, got ${String(actualHash)}`,
        );
      }
    }
  }
};

/**
 * Inject a plugin's adapter into all tabs matching its URL patterns.
 *
 * @param forceReinject - When true, re-inject even if the adapter is already
 *   present. Used by plugin.update to overwrite stale adapter code in existing
 *   tabs. When false (default), tabs that already have the adapter are skipped
 *   (used by sync.full and tabs.onUpdated to avoid redundant injection).
 */
export const injectPluginIntoMatchingTabs = async (
  pluginName: string,
  urlPatterns: string[],
  forceReinject = false,
  version?: string,
  adapterHash?: string,
): Promise<number[]> => {
  if (!isSafePluginName(pluginName)) {
    console.warn(`[opentabs] Skipping injection for unsafe plugin name: ${pluginName}`);
    return [];
  }

  // Collect all unique matching tabs across all URL patterns
  const tabMap = new Map<number, chrome.tabs.Tab>();
  for (const pattern of urlPatterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const tab of tabs) {
        if (tab.id !== undefined && !tabMap.has(tab.id)) {
          tabMap.set(tab.id, tab);
        }
      }
    } catch (err) {
      console.warn(`[opentabs] chrome.tabs.query failed for pattern ${pattern}:`, err);
    }
  }

  // Process all tabs in parallel: check presence + inject
  const results = await Promise.allSettled(
    Array.from(tabMap.keys()).map(async tabId => {
      if (!forceReinject && (await isAdapterPresent(tabId, pluginName))) {
        return tabId;
      }

      // Belt-and-suspenders with the IIFE wrapper's self-teardown (US-001):
      // call teardown from the extension side first, so cleanup happens even
      // if the adapter was injected by an older SDK version without wrapper
      // teardown support.
      if (forceReinject) {
        await chrome.scripting
          .executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (pName: string) => {
              const ot = (globalThis as Record<string, unknown>).__openTabs as
                | { adapters?: Record<string, { teardown?: () => void }> }
                | undefined;
              const adapter = ot?.adapters?.[pName];
              if (adapter && typeof adapter.teardown === 'function') {
                try {
                  adapter.teardown();
                } catch (e) {
                  console.warn('[OpenTabs] teardown error:', e);
                }
              }
            },
            args: [pluginName],
          })
          .catch(() => {});
      }

      await injectAdapterFile(tabId, pluginName, version, adapterHash);
      return tabId;
    }),
  );

  const injectedTabIds: number[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      injectedTabIds.push(result.value);
    }
  }

  return injectedTabIds;
};

/**
 * Inject all stored plugins whose URL patterns match the given tab.
 * Called on chrome.tabs.onUpdated (status=complete) so that tabs opened
 * AFTER sync.full still get their adapter files.
 */
export const injectPluginsIntoTab = async (tabId: number, tabUrl: string): Promise<void> => {
  const index = await getAllPluginMeta();
  const plugins = Object.values(index);

  if (plugins.length === 0) return;

  // Filter to plugins whose URL patterns match this tab and have safe names
  const matching = plugins.filter(p => isSafePluginName(p.name) && urlMatchesPatterns(tabUrl, p.urlPatterns));
  if (matching.length === 0) return;

  // Check presence for all matching plugins in parallel
  const presenceResults = await Promise.allSettled(
    matching.map(async plugin => ({
      plugin,
      present: await isAdapterPresent(tabId, plugin.name),
    })),
  );

  const needsInjection = presenceResults
    .filter(
      (r): r is PromiseFulfilledResult<{ plugin: (typeof matching)[0]; present: boolean }> =>
        r.status === 'fulfilled' && !r.value.present,
    )
    .map(r => r.value.plugin);

  if (needsInjection.length === 0) return;

  // Inject all needed plugins in parallel
  await Promise.allSettled(
    needsInjection.map(async plugin => {
      try {
        await injectAdapterFile(tabId, plugin.name, plugin.version, plugin.adapterHash);
      } catch (err) {
        console.warn(`[opentabs] Injection failed for tab ${String(tabId)}, plugin ${plugin.name}:`, err);
      }
    }),
  );
};

/**
 * Remove injected adapter from all tabs matching the plugin's URL patterns.
 * Called on plugin.uninstall to clean up __openTabs.adapters[pluginName].
 */
export const cleanupAdaptersInMatchingTabs = async (pluginName: string, urlPatterns: string[]): Promise<void> => {
  if (!isSafePluginName(pluginName)) {
    console.warn(`[opentabs] Skipping cleanup for unsafe plugin name: ${pluginName}`);
    return;
  }

  // Collect all unique matching tabs across all URL patterns
  const tabMap = new Map<number, chrome.tabs.Tab>();
  for (const pattern of urlPatterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const tab of tabs) {
        if (tab.id !== undefined && !tabMap.has(tab.id)) {
          tabMap.set(tab.id, tab);
        }
      }
    } catch (err) {
      console.warn(`[opentabs] chrome.tabs.query failed for pattern ${pattern}:`, err);
    }
  }

  // Run cleanup scripts in parallel across all matching tabs
  await Promise.allSettled(
    Array.from(tabMap.keys()).map(async tabId => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (pName: string) => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | { adapters?: Record<string, { teardown?: () => void }> }
              | undefined;
            const adapters = ot?.adapters;
            if (!adapters) return;
            const adapter = adapters[pName];
            if (adapter) {
              if (typeof adapter.teardown === 'function') {
                try {
                  adapter.teardown();
                } catch (e) {
                  console.warn('[OpenTabs] teardown error:', e);
                }
              }
              Reflect.deleteProperty(adapters, pName);
            }
          },
          args: [pluginName],
        });
      } catch (err) {
        console.warn(`[opentabs] Cleanup failed for tab ${String(tabId)}, plugin ${pluginName}:`, err);
      }
    }),
  );
};

/** Re-inject stored plugins into matching tabs on startup (parallel) */
export const reinjectStoredPlugins = async (): Promise<void> => {
  const index = await getAllPluginMeta();
  const plugins = Object.values(index);
  if (plugins.length === 0) return;

  const results = await Promise.allSettled(
    plugins.map(plugin =>
      injectPluginIntoMatchingTabs(plugin.name, plugin.urlPatterns, false, plugin.version, plugin.adapterHash),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && result.status === 'rejected') {
      const plugin = plugins[i];
      console.warn(`[opentabs] Failed to reinject stored plugin ${plugin?.name ?? 'unknown'}:`, result.reason);
    }
  }
};
