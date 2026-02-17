import { SCRIPT_TIMEOUT_MS } from './constants.js';
import { sendToServer } from './messaging.js';
import { getPluginMeta } from './plugin-storage.js';
import { findMatchingTab } from './tab-matching.js';
import type { PluginMeta } from './types.js';

/**
 * Get the link for console.warn logging: npm URL for published plugins, filesystem path for local.
 */
const getPluginLink = (plugin: PluginMeta): string => {
  if (plugin.trustTier === 'local' && plugin.sourcePath) {
    return plugin.sourcePath;
  }
  if (plugin.trustTier === 'official') {
    return `https://npmjs.com/package/@opentabs-dev/plugin-${plugin.name}`;
  }
  return `https://npmjs.com/package/opentabs-plugin-${plugin.name}`;
};

/**
 * Inject a console.warn into the target tab before tool execution for transparency.
 */
const injectToolInvocationLog = async (
  tabId: number,
  pluginName: string,
  toolName: string,
  link: string,
): Promise<void> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (pName: string, tName: string, lnk: string) => {
        console.warn(`[OpenTabs] ${pName}.${tName} invoked — ${lnk}`);
      },
      args: [pluginName, toolName, link],
    });
  } catch {
    // Tab may not be injectable — logging is best-effort
  }
};

/**
 * Handle tool.dispatch request from MCP server.
 * Finds matching tab, checks adapter readiness, executes tool, returns result.
 */
export const handleToolDispatch = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  const pluginName = params.plugin;
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Missing or invalid "plugin" param (expected non-empty string)' },
      id,
    });
    return;
  }

  const toolName = params.tool;
  if (typeof toolName !== 'string' || toolName.length === 0) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Missing or invalid "tool" param (expected non-empty string)' },
      id,
    });
    return;
  }

  const rawInput = params.input;
  if (rawInput !== undefined && rawInput !== null && (typeof rawInput !== 'object' || Array.isArray(rawInput))) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid "input" param (expected object)' },
      id,
    });
    return;
  }
  const input = (rawInput ?? {}) as Record<string, unknown>;

  const plugin = await getPluginMeta(pluginName);
  if (!plugin) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: `Plugin "${pluginName}" not found` },
      id,
    });
    return;
  }

  const tab = await findMatchingTab(plugin);
  if (!tab || tab.id === undefined) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32001, message: `No matching tab for plugin "${pluginName}" (state: closed)` },
      id,
    });
    return;
  }

  const link = getPluginLink(plugin);
  await injectToolInvocationLog(tab.id, pluginName, toolName, link);

  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (pName: string, tName: string, tInput: Record<string, unknown>) => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | {
              adapters?: Record<
                string,
                {
                  isReady(): Promise<boolean>;
                  tools: Array<{ name: string; handle(params: unknown): Promise<unknown> }>;
                }
              >;
            }
          | undefined;
        const adapter = ot?.adapters?.[pName];
        if (!adapter || typeof adapter !== 'object') {
          return { type: 'error' as const, code: -32002, message: `Adapter "${pName}" not injected or not ready` };
        }

        if (typeof adapter.isReady !== 'function') {
          return { type: 'error' as const, code: -32002, message: `Adapter "${pName}" has no isReady function` };
        }

        if (!Array.isArray(adapter.tools)) {
          return { type: 'error' as const, code: -32002, message: `Adapter "${pName}" has no tools array` };
        }

        let ready: boolean;
        try {
          ready = await adapter.isReady();
        } catch {
          return { type: 'error' as const, code: -32002, message: `Adapter "${pName}" isReady() threw an error` };
        }

        if (!ready) {
          return {
            type: 'error' as const,
            code: -32002,
            message: `Plugin "${pName}" is not ready (state: unavailable)`,
          };
        }

        const tool = adapter.tools.find((t: { name: string }) => t.name === tName);
        if (!tool || typeof tool.handle !== 'function') {
          return { type: 'error' as const, code: -32603, message: `Tool "${tName}" not found in adapter "${pName}"` };
        }

        try {
          const output = await tool.handle(tInput);
          return { type: 'success' as const, output };
        } catch (err: unknown) {
          const e = err as { message?: string; code?: string };
          return {
            type: 'error' as const,
            code: -32603,
            message: e.message ?? 'Tool execution failed',
            data: typeof e.code === 'string' ? { code: e.code } : undefined,
          };
        }
      },
      args: [pluginName, toolName, input],
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`));
      }, SCRIPT_TIMEOUT_MS);
    });

    let results: Awaited<typeof scriptPromise>;
    try {
      results = await Promise.race([scriptPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    const firstResult = results[0] as { result?: unknown } | undefined;
    const result = firstResult?.result as
      | { type: 'error'; code: number; message: string; data?: { code: string } }
      | { type: 'success'; output: unknown }
      | undefined;

    if (!result || typeof result !== 'object' || !('type' in result)) {
      sendToServer({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'No result from tool execution' },
        id,
      });
      return;
    }

    if (result.type === 'error') {
      sendToServer({
        jsonrpc: '2.0',
        error: { code: result.code, message: result.message, data: result.data },
        id,
      });
      return;
    }

    sendToServer({
      jsonrpc: '2.0',
      result: { output: result.output },
      id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTabGone = msg.includes('No tab with id') || msg.includes('Cannot access');
    sendToServer({
      jsonrpc: '2.0',
      error: {
        code: isTabGone ? -32001 : -32603,
        message: isTabGone ? 'Tab closed before tool execution' : `Script execution failed: ${msg}`,
      },
      id,
    });
  }
};
