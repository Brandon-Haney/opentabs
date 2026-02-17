/**
 * Extension WebSocket protocol handler.
 * Handles JSON-RPC messages between the MCP server and Chrome extension.
 */

import { getAdaptersDir } from './config.js';
import { log } from './logger.js';
import { prefixedToolName, isToolEnabled, getNextRequestId, DISPATCH_TIMEOUT_MS } from './state.js';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerState, TabMapping, PendingDispatch } from './state.js';
import type {
  ConfigSetAllToolsEnabledParams,
  ConfigSetToolEnabledParams,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResult,
  TabSyncAllParams,
  WsHandle,
} from '@opentabs-dev/shared';

/**
 * Ensure the adapters directory exists, creating it if necessary.
 * Caches the result so mkdir is called at most once per module evaluation
 * (resets on bun --hot reload, which is correct since the config dir could change).
 */
let adaptersDirReady = false;
const ensureAdaptersDir = async (): Promise<void> => {
  if (adaptersDirReady) return;
  await mkdir(getAdaptersDir(), { recursive: true });
  adaptersDirReady = true;
};

/** Maximum incoming WebSocket message size (10MB) */
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;

/**
 * Send a JSON-serialized message to the extension WebSocket if connected.
 * Centralizes the null check on state.extensionWs so callers don't repeat it.
 * Returns true if the message was sent, false if the extension is not connected.
 */
const sendToExtension = (
  state: ServerState,
  msg: JsonRpcNotification | JsonRpcResult | JsonRpcRequest | JsonRpcError,
): boolean => {
  if (!state.extensionWs) return false;
  try {
    state.extensionWs.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    log.warn(`Failed to send to extension: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

/** Callbacks the extension protocol can invoke on the MCP side */
interface McpCallbacks {
  onToolConfigChanged: () => void;
  onToolConfigPersist: () => void;
}

/**
 * Write a plugin's adapter IIFE to the extension's adapters/ directory.
 * The extension injects adapters via chrome.scripting.executeScript({ files: [...] })
 * using these files, bypassing page CSP restrictions.
 */
const writeAdapterFile = async (pluginName: string, iife: string): Promise<void> => {
  const adaptersDir = getAdaptersDir();
  const finalPath = join(adaptersDir, `${pluginName}.js`);
  const tmpPath = join(adaptersDir, `${pluginName}.js.tmp`);
  await Bun.write(tmpPath, iife);
  await rename(tmpPath, finalPath);
};

/**
 * Remove stale adapter .js files from the adapters directory that do not
 * correspond to any plugin in the current set. Called from sendSyncFull
 * before writing new adapter files.
 */
const cleanupStaleAdapterFiles = async (currentPluginNames: Set<string>): Promise<void> => {
  const adaptersDir = getAdaptersDir();
  let entries: string[];
  try {
    entries = await readdir(adaptersDir);
  } catch {
    // Directory may not exist yet on first run
    return;
  }

  const staleFiles = entries.filter(f => {
    if (!f.endsWith('.js') || f.endsWith('.js.tmp')) return false;
    const pluginName = f.slice(0, -3); // strip '.js'
    return !currentPluginNames.has(pluginName);
  });

  if (staleFiles.length === 0) return;

  const results = await Promise.allSettled(staleFiles.map(f => Bun.file(join(adaptersDir, f)).delete()));
  let deleted = 0;
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const fileName = staleFiles[i] ?? 'unknown';
      log.warn(
        `Failed to delete stale adapter file ${fileName}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    } else {
      deleted++;
    }
  }
  log.info(`Cleaned up ${deleted} stale adapter file(s)`);
};

/** Timeout for batch adapter file writes in sendSyncFull (10 seconds) */
const ADAPTER_WRITE_TIMEOUT_MS = 10_000;

/** Create a cancellable timeout promise for use with Promise.race */
const timeoutRace = <T>(value: T, ms: number): { promise: Promise<T>; cancel: () => void } => {
  let timerId: ReturnType<typeof setTimeout>;
  const promise = new Promise<T>(resolve => {
    timerId = setTimeout(() => resolve(value), ms);
  });
  // timerId is assigned synchronously by the Promise executor
  const cancel = () => clearTimeout(timerId);
  return { promise, cancel };
};

/**
 * Send sync.full notification to extension on connect.
 * Writes all plugin adapter IIFEs to the extension's adapters/ directory,
 * then sends plugin metadata (without IIFE content) to the extension.
 */
const sendSyncFull = async (state: ServerState): Promise<void> => {
  // Write all adapter IIFEs to disk so the extension can inject them as files.
  // Uses allSettled so a single plugin's write failure doesn't block the sync notification.
  // Races against a timeout so stalled writes don't hang hot reload indefinitely.
  const pluginList = Array.from(state.plugins.values());
  await ensureAdaptersDir();

  // Remove stale adapter files from plugins that are no longer in the current set
  const currentPluginNames = new Set(pluginList.map(p => p.name));
  await cleanupStaleAdapterFiles(currentPluginNames);

  const writePromise = Promise.allSettled(pluginList.map(p => writeAdapterFile(p.name, p.iife)));
  const timeout = timeoutRace<null>(null, ADAPTER_WRITE_TIMEOUT_MS);
  const writeResults = await Promise.race([writePromise, timeout.promise]);
  timeout.cancel();

  if (writeResults === null) {
    log.warn(
      `Adapter file writes did not complete within ${ADAPTER_WRITE_TIMEOUT_MS}ms — sending sync.full with available adapters. Pending plugins: ${pluginList.map(p => p.name).join(', ')}`,
    );
  } else {
    for (const [i, result] of writeResults.entries()) {
      if (result.status === 'rejected') {
        const plugin = pluginList[i];
        log.warn(
          `Failed to write adapter file for ${plugin?.name ?? 'unknown'}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
  }

  const plugins = pluginList.map(p => ({
    name: p.name,
    version: p.version,
    displayName: p.displayName,
    urlPatterns: p.urlPatterns,
    trustTier: p.trustTier,
    sourcePath: p.sourcePath,
    adapterHash: p.adapterHash,
    tools: p.tools.map(t => ({
      name: t.name,
      description: t.description,
      enabled: isToolEnabled(state, prefixedToolName(p.name, t.name)),
    })),
  }));

  sendToExtension(state, {
    jsonrpc: '2.0',
    method: 'sync.full',
    params: { plugins },
  });
};

/**
 * Send a JSON-RPC request to the extension and return a promise for the response.
 * Unified dispatch for both browser commands (browser.*, extension.*) and
 * plugin tool dispatches (tool.dispatch).
 *
 * @param label - Human-readable description for timeout error messages
 *   (e.g., "browser.openTab" or "slack/send_message")
 */
const dispatchToExtension = (
  state: ServerState,
  method: string,
  params: Record<string, unknown>,
  label?: string,
): Promise<unknown> => {
  const ws = state.extensionWs;
  if (!ws) {
    return Promise.reject(new Error('Extension not connected'));
  }

  const id = getNextRequestId(state);

  const msg: JsonRpcRequest = {
    jsonrpc: '2.0',
    method,
    params,
    id,
  };

  const dispatchLabel = label ?? method;

  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      if (state.pendingDispatches.has(id)) {
        state.pendingDispatches.delete(id);
        reject(new Error(`Dispatch ${dispatchLabel} timed out after ${DISPATCH_TIMEOUT_MS}ms`));
      }
    }, DISPATCH_TIMEOUT_MS);

    const pending: PendingDispatch = {
      resolve,
      reject,
      label: dispatchLabel,
      startTs: Date.now(),
      timerId,
    };
    state.pendingDispatches.set(id, pending);

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      clearTimeout(timerId);
      state.pendingDispatches.delete(id);
      reject(new Error(`WebSocket send failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
};

/**
 * Send tool.invocationStart notification to extension (for side panel animation).
 */
const sendInvocationStart = (state: ServerState, plugin: string, tool: string): void => {
  sendToExtension(state, {
    jsonrpc: '2.0',
    method: 'tool.invocationStart',
    params: { plugin, tool, ts: Date.now() },
  });
};

/**
 * Send tool.invocationEnd notification to extension (for side panel animation).
 */
const sendInvocationEnd = (
  state: ServerState,
  plugin: string,
  tool: string,
  durationMs: number,
  success: boolean,
): void => {
  sendToExtension(state, {
    jsonrpc: '2.0',
    method: 'tool.invocationEnd',
    params: { plugin, tool, durationMs, success },
  });
};

/**
 * Send plugin.update notification to extension with updated plugin metadata.
 * Writes the adapter IIFE to the extension's adapters/ directory first,
 * then sends the notification (without IIFE content) to the extension.
 *
 * Used by file watcher when a local plugin's manifest or IIFE changes on disk,
 * and by the hot reload sequence after re-discovery.
 *
 * Sent as a JSON-RPC notification (no id, no response expected). The extension
 * processes the update and re-injects the adapter into matching tabs.
 */
const sendPluginUpdate = async (state: ServerState, pluginName: string, iife: string): Promise<void> => {
  const plugin = state.plugins.get(pluginName);
  if (!plugin) return;

  await ensureAdaptersDir();
  await writeAdapterFile(pluginName, iife);

  sendToExtension(state, {
    jsonrpc: '2.0',
    method: 'plugin.update',
    params: {
      name: plugin.name,
      version: plugin.version,
      displayName: plugin.displayName,
      urlPatterns: plugin.urlPatterns,
      trustTier: plugin.trustTier,
      sourcePath: plugin.sourcePath,
      adapterHash: plugin.adapterHash,
      tools: plugin.tools.map(t => ({
        name: t.name,
        description: t.description,
        enabled: isToolEnabled(state, prefixedToolName(plugin.name, t.name)),
      })),
    },
  });
};

/**
 * Handle an incoming WebSocket message from the extension.
 * Routes to the appropriate handler based on method/id.
 *
 * @param senderWs - The raw WebSocket that sent this message. Used to reply
 *   pongs on the exact connection that pinged, preventing race conditions
 *   during hot reload when two connections may briefly coexist.
 */
const handleExtensionMessage = (
  state: ServerState,
  text: string,
  callbacks: McpCallbacks,
  senderWs?: WsHandle,
): void => {
  if (text.length > MAX_MESSAGE_SIZE) {
    log.warn(
      `Dropping oversized WebSocket message (${(text.length / 1024 / 1024).toFixed(1)}MB, limit ${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`,
    );
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    log.warn('Dropping malformed WebSocket message (invalid JSON)');
    return;
  }

  const method = parsed.method as string | undefined;
  const id = parsed.id as string | number | undefined;

  // Handle ping keepalive — reply on the SAME ws that sent the ping.
  // This is critical during hot reload: if the old connection sends a ping
  // before it's closed, the pong must go back on that connection (not the
  // new one stored in state.extensionWs).
  if (method === 'ping') {
    const replyWs = senderWs ?? state.extensionWs;
    replyWs?.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong' } satisfies JsonRpcNotification));
    return;
  }

  // Handle responses to our requests (tool.dispatch responses)
  if (id !== undefined && !method) {
    const pending = state.pendingDispatches.get(id);
    if (!pending) return;

    state.pendingDispatches.delete(id);
    clearTimeout(pending.timerId);

    if ('error' in parsed) {
      const err = parsed.error as { code: number; message: string; data?: Record<string, unknown> };
      const error = new DispatchError(err.message, err.code, err.data);
      pending.reject(error);
    } else {
      pending.resolve(parsed.result);
    }
    return;
  }

  // Handle notifications/requests from extension
  if (method === 'tab.syncAll') {
    handleTabSyncAll(state, parsed.params as Record<string, unknown>);
    return;
  }

  if (method === 'tab.stateChanged') {
    handleTabStateChanged(state, parsed.params as Record<string, unknown>, id);
    return;
  }

  // Handle config operations (requests with id from side panel, relayed through extension)
  if (method === 'config.getState' && id !== undefined) {
    handleConfigGetState(state, id);
    return;
  }

  if (method === 'config.setToolEnabled' && id !== undefined) {
    handleConfigSetToolEnabled(state, parsed.params as Record<string, unknown>, id, callbacks);
    return;
  }

  if (method === 'config.setAllToolsEnabled' && id !== undefined) {
    handleConfigSetAllToolsEnabled(state, parsed.params as Record<string, unknown>, id, callbacks);
    return;
  }

  // Unrecognized method with an id — send JSON-RPC -32601 'Method not found'
  if (id !== undefined && method) {
    sendToExtension(state, {
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method not found: ${method}` },
      id,
    });
    return;
  }

  // Unrecognized notification or malformed message
  if (method) {
    log.warn(`Ignoring unrecognized notification: ${method}`);
  } else if (id === undefined) {
    log.warn('Dropping unrecognized WebSocket message (no method, no id)');
  }
};

/**
 * Error class for tool dispatch errors with JSON-RPC error codes.
 *
 * Not exported — consumers must use isDispatchError() for type narrowing.
 * Under bun --hot, each module re-evaluation creates a new class identity,
 * so `instanceof DispatchError` fails across reload boundaries. The duck-typed
 * isDispatchError() guard is co-located here to make the correct approach
 * obvious and the incorrect approach (importing the class) impossible.
 */
class DispatchError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

/**
 * Check if an error is a DispatchError by duck-typing rather than instanceof.
 *
 * Under bun --hot, each module re-evaluation creates a new DispatchError class.
 * If a tool dispatch timeout fires after hot reload, the error is an instance of
 * the OLD module's DispatchError class. Using `instanceof` against the NEW
 * module's DispatchError would fail, causing the error to fall through to the
 * generic catch branch and lose the specific error code/message. Duck-typing
 * avoids this cross-reload class identity problem.
 */
const isDispatchError = (
  err: unknown,
): err is { name: string; message: string; code: number; data?: Record<string, unknown> } =>
  err !== null &&
  typeof err === 'object' &&
  'code' in err &&
  'name' in err &&
  (err as { name: unknown }).name === 'DispatchError';

// --- Internal handlers ---

/** Wire shape for tab mapping entries — all fields may be absent or wrong type */
interface WireTabMapping {
  state?: string;
  tabId?: number | null;
  url?: string | null;
}

const parseTabMapping = (wire: WireTabMapping): TabMapping => ({
  state: wire.state === 'closed' || wire.state === 'unavailable' || wire.state === 'ready' ? wire.state : 'closed',
  tabId: typeof wire.tabId === 'number' ? wire.tabId : null,
  url: typeof wire.url === 'string' ? wire.url : null,
});

const handleTabSyncAll = (state: ServerState, params: Record<string, unknown> | undefined): void => {
  if (!params) return;
  const tabSyncParams = params as Partial<TabSyncAllParams>;
  const tabs = tabSyncParams.tabs;
  if (!tabs) return;

  state.tabMapping.clear();
  for (const [pluginName, mapping] of Object.entries(tabs)) {
    state.tabMapping.set(pluginName, parseTabMapping(mapping as WireTabMapping));
  }

  log.info(`tab.syncAll received — ${state.tabMapping.size} plugin(s) mapped`);
};

const handleTabStateChanged = (
  state: ServerState,
  params: Record<string, unknown> | undefined,
  id?: string | number,
): void => {
  const sendError = (message: string): void => {
    if (id !== undefined) {
      sendToExtension(state, { jsonrpc: '2.0', error: { code: -32602, message }, id });
    } else {
      log.warn(`tab.stateChanged: ${message}`);
    }
  };

  if (!params) {
    sendError('Missing params');
    return;
  }

  const plugin = params.plugin;
  if (typeof plugin !== 'string' || plugin.length === 0) {
    sendError('Missing or invalid "plugin" field (expected non-empty string)');
    return;
  }

  if (typeof params.state !== 'string') {
    sendError('Missing or invalid "state" field (expected string)');
    return;
  }

  const wire: WireTabMapping = {
    state: params.state,
    tabId: typeof params.tabId === 'number' ? params.tabId : null,
    url: typeof params.url === 'string' ? params.url : null,
  };
  state.tabMapping.set(plugin, parseTabMapping(wire));

  log.info(`tab.stateChanged: ${plugin} → ${wire.state ?? 'unknown'}`);
};

const handleConfigGetState = (state: ServerState, id: string | number): void => {
  const plugins = Array.from(state.plugins.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => {
      const tabInfo = state.tabMapping.get(p.name);
      return {
        name: p.name,
        displayName: p.displayName ?? p.name,
        version: p.version,
        trustTier: p.trustTier,
        tabState: tabInfo?.state ?? 'closed',
        urlPatterns: p.urlPatterns,
        tools: p.tools.map(t => ({
          name: t.name,
          description: t.description,
          enabled: isToolEnabled(state, prefixedToolName(p.name, t.name)),
        })),
      };
    });

  sendToExtension(state, {
    jsonrpc: '2.0',
    result: {
      plugins,
      outdatedPlugins: state.outdatedPlugins,
    },
    id,
  });
};

const handleConfigSetToolEnabled = (
  state: ServerState,
  params: Record<string, unknown> | undefined,
  id: string | number,
  callbacks: McpCallbacks,
): void => {
  if (!params) {
    sendToExtension(state, { jsonrpc: '2.0', error: { code: -32602, message: 'Missing params' }, id });
    return;
  }

  const toolEnabledParams = params as Partial<ConfigSetToolEnabledParams>;
  const pluginName = toolEnabledParams.plugin;
  const tool = toolEnabledParams.tool;
  const enabled = toolEnabledParams.enabled;

  if (typeof pluginName !== 'string' || typeof tool !== 'string' || typeof enabled !== 'boolean') {
    sendToExtension(state, {
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params: expected plugin (string), tool (string), enabled (boolean)' },
      id,
    });
    return;
  }

  const plugin = state.plugins.get(pluginName);
  if (!plugin) {
    sendToExtension(state, {
      jsonrpc: '2.0',
      error: { code: -32602, message: `Plugin not found: ${pluginName}` },
      id,
    });
    return;
  }

  if (!plugin.tools.some(t => t.name === tool)) {
    sendToExtension(state, {
      jsonrpc: '2.0',
      error: { code: -32602, message: `Tool not found: ${tool} in plugin ${pluginName}` },
      id,
    });
    return;
  }

  const prefixed = prefixedToolName(pluginName, tool);
  state.toolConfig[prefixed] = enabled;
  callbacks.onToolConfigChanged();
  callbacks.onToolConfigPersist();

  sendToExtension(state, {
    jsonrpc: '2.0',
    result: { ok: true },
    id,
  });
};

const handleConfigSetAllToolsEnabled = (
  state: ServerState,
  params: Record<string, unknown> | undefined,
  id: string | number,
  callbacks: McpCallbacks,
): void => {
  if (!params) {
    sendToExtension(state, { jsonrpc: '2.0', error: { code: -32602, message: 'Missing params' }, id });
    return;
  }

  const allToolsEnabledParams = params as Partial<ConfigSetAllToolsEnabledParams>;
  const pluginName = allToolsEnabledParams.plugin;
  const enabled = allToolsEnabledParams.enabled;

  if (typeof pluginName !== 'string' || typeof enabled !== 'boolean') {
    sendToExtension(state, {
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params: expected plugin (string), enabled (boolean)' },
      id,
    });
    return;
  }

  const plugin = state.plugins.get(pluginName);
  if (!plugin) {
    sendToExtension(state, {
      jsonrpc: '2.0',
      error: { code: -32602, message: `Plugin not found: ${pluginName}` },
      id,
    });
    return;
  }

  for (const tool of plugin.tools) {
    const prefixed = prefixedToolName(pluginName, tool.name);
    state.toolConfig[prefixed] = enabled;
  }
  callbacks.onToolConfigChanged();
  callbacks.onToolConfigPersist();

  sendToExtension(state, {
    jsonrpc: '2.0',
    result: { ok: true },
    id,
  });
};

export type { McpCallbacks };
export {
  sendSyncFull,
  dispatchToExtension,
  sendInvocationStart,
  sendInvocationEnd,
  sendPluginUpdate,
  handleExtensionMessage,
  isDispatchError,
  writeAdapterFile,
};
