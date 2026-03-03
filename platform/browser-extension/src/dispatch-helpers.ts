import {
  JSONRPC_ADAPTER_NOT_READY,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_NO_USABLE_TAB,
  JSONRPC_TAB_NOT_MATCHED,
} from './json-rpc-errors.js';
import { sendToServer } from './messaging.js';
import { getPluginMeta } from './plugin-storage.js';
import { sanitizeErrorMessage } from './sanitize-error.js';
import { findAllMatchingTabs, urlMatchesPatterns } from './tab-matching.js';
import { toErrorMessage } from '@opentabs-dev/shared';
import type { PluginMeta } from './extension-messages.js';

/**
 * Structured result from a MAIN-world adapter script execution.
 * Covers tool dispatches.
 */
type DispatchResult =
  | {
      type: 'error';
      code: number;
      message: string;
      data?: { code: string; retryable?: boolean; retryAfterMs?: number; category?: string };
    }
  | { type: 'success'; output: unknown };

/**
 * Whether a DispatchResult is an adapter-not-ready error (JSONRPC_ADAPTER_NOT_READY)
 * that should trigger fallback to the next matching tab.
 */
const isAdapterNotReady = (result: DispatchResult): boolean =>
  result.type === 'error' && result.code === JSONRPC_ADAPTER_NOT_READY;

/**
 * Look up plugin metadata by name.
 * Sends a JSONRPC_INTERNAL_ERROR via sendToServer if the plugin is not found.
 * Returns the plugin metadata on success, or null on failure.
 */
const resolvePlugin = async (pluginName: string, id: string | number): Promise<PluginMeta | null> => {
  const plugin = await getPluginMeta(pluginName);
  if (!plugin) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: JSONRPC_INTERNAL_ERROR, message: `Plugin "${pluginName}" not found` },
      id,
    });
    return null;
  }
  return plugin;
};

/**
 * Execute a chrome.scripting.executeScript call with a timeout and extract
 * the first result. Returns a DispatchResult on success, or throws if the
 * tab is inaccessible (e.g., closed).
 *
 * @param scriptPromise - The promise returned by chrome.scripting.executeScript
 * @param timeoutMs - Timeout in milliseconds (defaults to SCRIPT_TIMEOUT_MS)
 * @param fallbackMessage - Error message when no result is returned
 */
const executeWithTimeout = async (
  scriptPromise: Promise<chrome.scripting.InjectionResult[]>,
  timeoutMs: number,
  fallbackMessage: string,
): Promise<DispatchResult> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let results: chrome.scripting.InjectionResult[];
  try {
    results = await Promise.race([scriptPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }

  const firstResult = results[0] as { result?: unknown } | undefined;
  const result = firstResult?.result as DispatchResult | undefined;

  if (!result || typeof result !== 'object' || !('type' in result)) {
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: fallbackMessage };
  }

  return result;
};

/**
 * Configuration for dispatchWithTabFallback.
 */
interface TabFallbackConfig {
  id: string | number;
  pluginName: string;
  plugin: PluginMeta;
  operationName: string;
  executeOnTab: (tabId: number) => Promise<DispatchResult>;
}

/**
 * Find matching tabs and iterate through them in ranked order, executing the
 * given callback on each. Handles TOCTOU URL revalidation, adapter-not-ready
 * fallback to the next tab, tab-gone detection, and error response routing.
 *
 * Sends the JSON-RPC response to the server and returns void.
 */
const dispatchWithTabFallback = async (config: TabFallbackConfig): Promise<void> => {
  const { id, pluginName, plugin, operationName, executeOnTab } = config;

  const matchingTabs = await findAllMatchingTabs(plugin);
  if (matchingTabs.length === 0) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: JSONRPC_NO_USABLE_TAB, message: `No matching tab for plugin "${pluginName}" (state: closed)` },
      id,
    });
    return;
  }

  let firstError:
    | {
        code: number;
        message: string;
        data?: { code: string; retryable?: boolean; retryAfterMs?: number; category?: string };
      }
    | undefined;

  for (const tab of matchingTabs) {
    if (tab.id === undefined) continue;

    // Re-validate tab URL to prevent TOCTOU race: the tab may have navigated
    // between findAllMatchingTabs() and now.
    try {
      const currentTab = await chrome.tabs.get(tab.id);
      if (!currentTab.url || !urlMatchesPatterns(currentTab.url, plugin.urlPatterns)) {
        firstError ??= { code: JSONRPC_NO_USABLE_TAB, message: 'Tab navigated away from matching URL' };
        continue;
      }
    } catch {
      firstError ??= { code: JSONRPC_NO_USABLE_TAB, message: `Tab closed before ${operationName}` };
      continue;
    }

    try {
      const result = await executeOnTab(tab.id);

      if (result.type === 'success') {
        sendToServer({ jsonrpc: '2.0', result: { output: result.output }, id });
        return;
      }

      // Adapter-not-ready errors trigger fallback to the next matching tab
      if (isAdapterNotReady(result) && matchingTabs.length > 1) {
        firstError ??= { code: result.code, message: sanitizeErrorMessage(result.message) };
        continue;
      }

      sendToServer({
        jsonrpc: '2.0',
        error: { code: result.code, message: sanitizeErrorMessage(result.message), data: result.data },
        id,
      });
      return;
    } catch (err) {
      const msg = toErrorMessage(err);
      const isTabGone = msg.includes('No tab with id') || msg.includes('Cannot access');
      if (isTabGone && matchingTabs.length > 1) {
        firstError ??= { code: JSONRPC_NO_USABLE_TAB, message: `Tab closed before ${operationName}` };
        continue;
      }
      sendToServer({
        jsonrpc: '2.0',
        error: {
          code: isTabGone ? JSONRPC_NO_USABLE_TAB : JSONRPC_INTERNAL_ERROR,
          message: isTabGone
            ? `Tab closed before ${operationName}`
            : `Script execution failed: ${sanitizeErrorMessage(msg)}`,
        },
        id,
      });
      return;
    }
  }

  // All matching tabs failed — return the error from the best-ranked tab
  if (firstError) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: firstError.code, message: firstError.message, data: firstError.data },
      id,
    });
  } else {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: JSONRPC_NO_USABLE_TAB, message: 'No usable tab found (all matching tabs have undefined IDs)' },
      id,
    });
  }
};

/**
 * Configuration for dispatchToTargetedTab.
 */
interface TargetedDispatchConfig {
  id: string | number;
  pluginName: string;
  plugin: PluginMeta;
  tabId: number;
  operationName: string;
  executeOnTab: (tabId: number) => Promise<DispatchResult>;
}

/**
 * Dispatch to a specific tab by ID. Validates that:
 * 1. The tab exists (chrome.tabs.get succeeds)
 * 2. The tab's URL matches the plugin's URL patterns (security check)
 * 3. The adapter is ready (no fallback to other tabs)
 *
 * Sends the JSON-RPC response to the server and returns void.
 */
const dispatchToTargetedTab = async (config: TargetedDispatchConfig): Promise<void> => {
  const { id, pluginName, plugin, tabId, operationName, executeOnTab } = config;

  // 1. Verify the tab exists
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    sendToServer({
      jsonrpc: '2.0',
      error: {
        code: JSONRPC_NO_USABLE_TAB,
        message: `Tab ${tabId} does not exist`,
      },
      id,
    });
    return;
  }

  // 2. Security check: verify the tab's URL matches the plugin's URL patterns
  if (!tab.url || !urlMatchesPatterns(tab.url, plugin.urlPatterns)) {
    sendToServer({
      jsonrpc: '2.0',
      error: {
        code: JSONRPC_TAB_NOT_MATCHED,
        message: `Tab ${tabId} does not match URL patterns for plugin "${pluginName}"`,
      },
      id,
    });
    return;
  }

  // 3. Execute on the targeted tab — no fallback to other tabs
  try {
    const result = await executeOnTab(tabId);

    if (result.type === 'success') {
      sendToServer({ jsonrpc: '2.0', result: { output: result.output }, id });
      return;
    }

    sendToServer({
      jsonrpc: '2.0',
      error: { code: result.code, message: sanitizeErrorMessage(result.message), data: result.data },
      id,
    });
  } catch (err) {
    const msg = toErrorMessage(err);
    const isTabGone = msg.includes('No tab with id') || msg.includes('Cannot access');
    sendToServer({
      jsonrpc: '2.0',
      error: {
        code: isTabGone ? JSONRPC_NO_USABLE_TAB : JSONRPC_INTERNAL_ERROR,
        message: isTabGone
          ? `Tab closed during ${operationName}`
          : `Script execution failed: ${sanitizeErrorMessage(msg)}`,
      },
      id,
    });
  }
};

export { dispatchToTargetedTab, dispatchWithTabFallback, executeWithTimeout, resolvePlugin, isAdapterNotReady };
export type { DispatchResult };
