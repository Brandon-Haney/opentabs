import { toErrorMessage } from '@opentabs-dev/shared';
import type { PluginMeta } from './extension-messages.js';
import {
  JSONRPC_ADAPTER_NOT_READY,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_NO_USABLE_TAB,
  JSONRPC_TAB_NOT_MATCHED,
} from './json-rpc-errors.js';
import { sendToServer } from './messaging.js';
import { getPluginMeta } from './plugin-storage.js';
import { type SanitizedDetails, sanitizeErrorDetails, sanitizeErrorMessage } from './sanitize-error.js';
import { findAllMatchingTabs, urlMatchesPatterns } from './tab-matching.js';

/**
 * Structured fields of a ToolError thrown by an adapter tool handler, read
 * duck-typed in the MAIN world and carried as `error.data` to the server.
 * `details` is the plugin's diagnostic object (upstream status, request id,
 * proxy error label); it is sanitized at the wire by sanitizeErrorDetails.
 */
interface DispatchErrorData {
  code: string;
  retryable?: boolean;
  retryAfterMs?: number;
  category?: string;
  details?: Record<string, unknown>;
}

/**
 * Structured result from a MAIN-world adapter script execution.
 * Covers tool dispatches.
 */
type DispatchResult =
  | {
      type: 'error';
      code: number;
      message: string;
      data?: DispatchErrorData;
    }
  | { type: 'success'; output: unknown };

/** DispatchErrorData whose `details` have passed through sanitizeErrorDetails. */
type SanitizedDispatchErrorData = Omit<DispatchErrorData, 'details'> & { details?: SanitizedDetails };

/**
 * `error.data` as sent to the server: the adapter's sanitized structured error
 * fields (present only when the tool threw a ToolError) plus `tabId`, the tab
 * the tool ran in. The server strips `tabId` before the error reaches the MCP
 * client and records it in the audit log.
 */
type WireErrorData = Partial<SanitizedDispatchErrorData> & { tabId: number };

/**
 * Whether a DispatchResult is an adapter-not-ready error (JSONRPC_ADAPTER_NOT_READY)
 * that should trigger fallback to the next matching tab.
 */
const isAdapterNotReady = (result: DispatchResult): boolean =>
  result.type === 'error' && result.code === JSONRPC_ADAPTER_NOT_READY;

/**
 * Sanitize the `details` of a structured error for the wire. Data without
 * details keeps its other fields as they are; details the sanitizer rejects
 * (not a plain object, or oversized) are omitted while the other fields are kept.
 */
const sanitizeDispatchErrorData = (data: DispatchErrorData | undefined): SanitizedDispatchErrorData | undefined => {
  if (data === undefined) return undefined;
  const { details, ...rest } = data;
  if (details === undefined) return rest;
  const sanitized = sanitizeErrorDetails(details);
  return sanitized === undefined ? rest : { ...rest, details: sanitized };
};

/** Build the wire `error.data` for an error produced while executing in `tabId`. */
const toWireErrorData = (data: DispatchErrorData | undefined, tabId: number): WireErrorData => ({
  ...sanitizeDispatchErrorData(data),
  tabId,
});

/**
 * Send the JSON-RPC response for a DispatchResult produced in `tabId`. Success
 * echoes `tabId` beside `output`; an error carries it in `error.data.tabId`.
 */
const sendTabResult = (id: string | number, result: DispatchResult, tabId: number): void => {
  if (result.type === 'success') {
    sendToServer({ jsonrpc: '2.0', result: { output: result.output, tabId }, id });
    return;
  }
  sendToServer({
    jsonrpc: '2.0',
    error: {
      code: result.code,
      message: sanitizeErrorMessage(result.message),
      data: toWireErrorData(result.data, tabId),
    },
    id,
  });
};

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
 * The error remembered from the best-ranked tab while fallback continues.
 * `tabId` is set when the error came out of an execution attempt on that tab,
 * and only such an error can carry the adapter's structured `data`. Both are
 * absent for pre-execution rejections (TOCTOU URL mismatch, tab closed before
 * the URL re-check), where no tool ran anywhere.
 */
type FirstTabError = { code: number; message: string } & (
  | { tabId: number; data?: DispatchErrorData }
  | { tabId?: undefined; data?: undefined }
);

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

  let firstError: FirstTabError | undefined;

  for (const tab of matchingTabs) {
    if (tab.id === undefined) continue;

    // Re-validate tab URL to prevent TOCTOU race: the tab may have navigated
    // between findAllMatchingTabs() and now.
    try {
      const currentTab = await chrome.tabs.get(tab.id);
      if (!currentTab.url || !urlMatchesPatterns(currentTab.url, plugin.urlPatterns, plugin.excludePatterns)) {
        firstError ??= { code: JSONRPC_NO_USABLE_TAB, message: 'Tab navigated away from matching URL' };
        continue;
      }
    } catch {
      firstError ??= { code: JSONRPC_NO_USABLE_TAB, message: `Tab closed before ${operationName}` };
      continue;
    }

    try {
      const result = await executeOnTab(tab.id);

      // Adapter-not-ready errors trigger fallback to the next matching tab
      if (result.type === 'error' && isAdapterNotReady(result) && matchingTabs.length > 1) {
        firstError ??= {
          code: result.code,
          message: sanitizeErrorMessage(result.message),
          data: result.data,
          tabId: tab.id,
        };
        continue;
      }

      sendTabResult(id, result, tab.id);
      return;
    } catch (err) {
      const msg = toErrorMessage(err);
      const isTabGone = msg.includes('No tab with id') || msg.includes('Cannot access');
      if (isTabGone && matchingTabs.length > 1) {
        firstError ??= { code: JSONRPC_NO_USABLE_TAB, message: `Tab closed during ${operationName}`, tabId: tab.id };
        continue;
      }
      sendToServer({
        jsonrpc: '2.0',
        error: {
          code: isTabGone ? JSONRPC_NO_USABLE_TAB : JSONRPC_INTERNAL_ERROR,
          message: isTabGone
            ? `Tab closed during ${operationName}`
            : `Script execution failed: ${sanitizeErrorMessage(msg)}`,
          data: { tabId: tab.id },
        },
        id,
      });
      return;
    }
  }

  // All matching tabs failed — return the error from the best-ranked tab
  if (firstError) {
    const data = firstError.tabId === undefined ? undefined : toWireErrorData(firstError.data, firstError.tabId);
    sendToServer({
      jsonrpc: '2.0',
      error: { code: firstError.code, message: firstError.message, data },
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
  if (!tab.url || !urlMatchesPatterns(tab.url, plugin.urlPatterns, plugin.excludePatterns)) {
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
    sendTabResult(id, result, tabId);
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
        data: { tabId },
      },
      id,
    });
  }
};

export type { DispatchErrorData, DispatchResult };
export { dispatchToTargetedTab, dispatchWithTabFallback, executeWithTimeout, isAdapterNotReady, resolvePlugin };
