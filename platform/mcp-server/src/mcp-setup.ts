/**
 * MCP server factory.
 * Creates a low-level Server instance and registers tools dynamically from
 * discovered plugins and built-in browser tools.
 *
 * Uses the low-level Server API (not McpServer) because plugin manifests provide
 * raw JSON Schema objects for tool input/output — McpServer.registerTool() requires
 * Zod schemas and cannot accept pre-computed JSON Schema. The Server class deprecation
 * message acknowledges this: "Only use Server for advanced use cases."
 *
 * The Server import uses dynamic import() to satisfy import-x/no-deprecated. The
 * @typescript-eslint/no-deprecated rule is addressed by typing through the awaited
 * module rather than referencing the deprecated class name directly.
 *
 * Hot reload:
 *   `registerMcpHandlers` is separated from `createMcpServer` so that existing
 *   MCP sessions can have their tools/list and tools/call handler logic refreshed
 *   on hot reload. After bun --hot re-evaluates this module, calling
 *   `registerMcpHandlers(server, state)` on each existing session replaces the
 *   old handler closures with new ones that reference the fresh module imports
 *   (dispatchToExtension, sendInvocationStart, etc.).
 */

import { dispatchToExtension, isDispatchError, sendInvocationStart, sendInvocationEnd } from './extension-protocol.js';
import { log } from './logger.js';
import { trustTierPrefix } from './registry.js';
import { prefixedToolName, isToolEnabled } from './state.js';
import { version } from './version.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ServerState, CachedBrowserTool, ToolLookupEntry } from './state.js';
import type { ZodError } from 'zod';

/** Maximum concurrent tool dispatches per plugin to prevent tab performance degradation */
const MAX_CONCURRENT_DISPATCHES_PER_PLUGIN = 5;

/** Keys that could trigger prototype pollution in JSON deserialization */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively remove dangerous keys from objects to prevent prototype pollution
 * in MCP clients that use naive JSON deserialization.
 */
const sanitizeOutput = (obj: unknown, depth = 0): unknown => {
  if (depth > 50 || obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => sanitizeOutput(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!DANGEROUS_KEYS.has(key)) result[key] = sanitizeOutput(value, depth + 1);
  }
  return result;
};

/**
 * The Server constructor type, extracted without directly referencing the
 * deprecated Server class name in a static import or type-only import.
 * We load it via dynamic import() at runtime to satisfy import-x/no-deprecated,
 * and use a generic constructor signature to avoid @typescript-eslint/no-deprecated.
 */

/** Shape of the dynamically imported server module */
interface ServerModuleShape {
  Server: new (
    serverInfo: { name: string; version: string },
    options: { capabilities: { tools: { listChanged: boolean }; logging: Record<string, never> } },
  ) => McpServerInstance;
}

/** Extra context passed to request handlers by the MCP SDK */
interface RequestHandlerExtra {
  signal: AbortSignal;
  sessionId?: string;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: string; params?: Record<string, unknown> }) => Promise<void>;
}

/** The instantiated MCP server with the methods we use */
interface McpServerInstance {
  setRequestHandler: (
    schema: unknown,
    handler: (
      request: { params: { name: string; arguments?: Record<string, unknown> } },
      extra: RequestHandlerExtra,
    ) => unknown,
  ) => void;
  connect: (transport: unknown) => Promise<void>;
  sendToolListChanged: () => Promise<void>;
  sendLoggingMessage: (params: { level: string; logger?: string; data?: unknown }) => Promise<void>;
}

/**
 * Dynamically import the MCP SDK Server constructor.
 *
 * Each call performs a fresh dynamic import(). Under bun --hot, module-level
 * caches reset on every re-evaluation, so caching here would be misleading —
 * it would appear to persist but actually reset to null on each reload. The
 * dynamic import is fast (resolved from the module cache by the runtime) and
 * only runs once per server creation or reload cycle.
 */
const getServerCtor = async (): Promise<ServerModuleShape['Server']> => {
  const mod = (await import('@modelcontextprotocol/sdk/server/index.js')) as ServerModuleShape;
  return mod.Server;
};

/**
 * Format a structured error response for MCP clients.
 *
 * When the error data contains structured fields (category, retryable, retryAfterMs),
 * produces a human-readable prefix line followed by a machine-readable JSON block.
 * When only the code is present (legacy), produces [CODE] message.
 */
const formatStructuredError = (code: string, message: string, data?: Record<string, unknown>): string => {
  const category = typeof data?.category === 'string' ? data.category : undefined;
  const retryable = typeof data?.retryable === 'boolean' ? data.retryable : undefined;
  const retryAfterMs = typeof data?.retryAfterMs === 'number' ? data.retryAfterMs : undefined;

  const hasStructuredFields = category !== undefined || retryable !== undefined || retryAfterMs !== undefined;

  if (!hasStructuredFields) {
    return `[${code}] ${message}`;
  }

  // Build the human-readable prefix with only present fields
  const parts = [`code=${code}`];
  if (category !== undefined) parts.push(`category=${category}`);
  if (retryable !== undefined) parts.push(`retryable=${String(retryable)}`);
  if (retryAfterMs !== undefined) parts.push(`retryAfterMs=${retryAfterMs}`);
  const prefix = `[ERROR ${parts.join(' ')}] ${message}`;

  // Build the machine-readable JSON block with only present fields
  const jsonObj: Record<string, unknown> = { code };
  if (category !== undefined) jsonObj.category = category;
  if (retryable !== undefined) jsonObj.retryable = retryable;
  if (retryAfterMs !== undefined) jsonObj.retryAfterMs = retryAfterMs;

  return `${prefix}\n\n\`\`\`json\n${JSON.stringify(jsonObj)}\n\`\`\``;
};

/** Format a ZodError into a readable validation message listing each failing field */
const formatZodError = (err: ZodError): string => {
  const issues = err.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `Invalid arguments:\n${issues.join('\n')}`;
};

/**
 * Rebuild cached browser tool JSON schemas on state.
 * Called after state.browserTools changes (during reload).
 * Plugin tool lookups are handled by the immutable registry.
 */
const rebuildCachedBrowserTools = (state: ServerState): void => {
  state.cachedBrowserTools = state.browserTools.map((bt): CachedBrowserTool => {
    const schema = z.toJSONSchema(bt.input) as Record<string, unknown>;
    delete schema['$schema'];
    return {
      name: bt.name,
      description: bt.description,
      inputSchema: schema,
      tool: bt,
    };
  });
};

/**
 * Register (or re-register) tools/list and tools/call handlers on an MCP Server
 * instance. Each handler creates fresh closures over the current module's imports
 * (dispatchToolToExtension, sendInvocationStart, etc.), ensuring that after hot
 * reload, existing sessions invoke the latest handler logic.
 *
 * Called by:
 *   1. `createMcpServer` — for new sessions
 *   2. Hot reload sequence in reload.ts — for existing sessions
 */
const registerMcpHandlers = (server: McpServerInstance, state: ServerState): void => {
  // Handler: tools/list — return enabled plugin tools + browser tools.
  // Delegates to getEnabledToolsList() which filters disabled plugin tools
  // and always includes browser tools.
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: getEnabledToolsList(state),
  }));

  // Handler: tools/call — dispatch to extension or handle browser tool locally.
  // Uses pre-built lookup maps for O(1) tool resolution.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};

    // Check cached browser tools first (O(n) over small fixed set).
    // Browser tools are few and fixed.
    const cachedBt = state.cachedBrowserTools.find(c => c.name === toolName);
    if (cachedBt) {
      // Validate args through the tool's Zod input schema
      const parseResult = cachedBt.tool.input.safeParse(args);
      if (!parseResult.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatZodError(parseResult.error),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await cachedBt.tool.handler(parseResult.data, state);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(sanitizeOutput(result), null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Browser tool error: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    }

    // O(1) plugin tool lookup + enabled check via pre-built map
    const callableCheck = checkToolCallable(state, toolName);
    if (!callableCheck.ok) {
      return {
        content: [{ type: 'text' as const, text: callableCheck.error }],
        isError: true,
      };
    }

    const { pluginName: foundPlugin, toolName: foundTool } = callableCheck;
    log.debug('tool.call:', toolName, '→', foundPlugin + '/' + foundTool);
    // Safe to assert: checkToolCallable verified the tool exists in registry.toolLookup
    const lookup = state.registry.toolLookup.get(toolName) as ToolLookupEntry;

    // Validate args against the tool's JSON Schema before dispatching.
    // The validator is pre-compiled at discovery time for performance.
    // If schema compilation failed, reject the call entirely — unvalidated
    // input must never reach plugin handlers.
    if (!lookup.validate) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Tool "${toolName}" cannot be called: schema compilation failed. ${lookup.validationErrors()}`,
          },
        ],
        isError: true,
      };
    }

    // Wrap validation in try-catch: compiled Ajv validators can throw on
    // pathological input (e.g., regex catastrophic backtracking from a
    // community plugin's pattern keyword). Normal schemas complete in
    // microseconds; this guard catches the unexpected edge case.
    let valid: boolean;
    try {
      valid = lookup.validate(args);
    } catch (err) {
      log.warn(`Schema validation threw for tool "${toolName}":`, err);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Tool "${toolName}" validation failed unexpectedly. The tool's schema may be invalid.`,
          },
        ],
        isError: true,
      };
    }
    if (!valid) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Invalid arguments for tool "${toolName}":\n${lookup.validationErrors()}`,
          },
        ],
        isError: true,
      };
    }

    log.debug('tool.call: input validated for', toolName);

    // Concurrency limit: prevent a runaway MCP client from flooding a single
    // plugin's tab with simultaneous executeScript calls. Each dispatch runs
    // in the page's MAIN world, so too many concurrent dispatches can degrade
    // the target tab's performance.
    const currentDispatches = state.activeDispatches.get(foundPlugin) ?? 0;
    if (currentDispatches >= MAX_CONCURRENT_DISPATCHES_PER_PLUGIN) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Too many concurrent dispatches for plugin "${foundPlugin}" (limit: ${MAX_CONCURRENT_DISPATCHES_PER_PLUGIN}). Wait for in-flight requests to complete.`,
          },
        ],
        isError: true,
      };
    }
    // Send invocation start notification to extension (for side panel)
    sendInvocationStart(state, foundPlugin, foundTool);
    const startTs = Date.now();
    let success = true;

    try {
      state.activeDispatches.set(foundPlugin, currentDispatches + 1);
      if (!state.extensionWs) {
        success = false;
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Extension not connected. Please ensure the OpenTabs Chrome extension is running.',
            },
          ],
          isError: true,
        };
      }

      log.debug('tool.call: dispatching', foundPlugin + '/' + foundTool);

      // Extract progressToken from MCP request _meta and build onProgress callback
      const progressToken = extra._meta?.progressToken;
      const onProgress =
        progressToken !== undefined
          ? (progress: number, total: number, message?: string) => {
              const params: Record<string, unknown> = { progressToken, progress, total };
              if (message !== undefined) params.message = message;
              extra.sendNotification({ method: 'notifications/progress', params }).catch(() => {
                // Fire-and-forget — errors in the progress chain must not affect tool execution
              });
            }
          : undefined;

      const result = await dispatchToExtension(
        state,
        'tool.dispatch',
        { plugin: foundPlugin, tool: foundTool, input: args },
        { label: `${foundPlugin}/${foundTool}`, progressToken, onProgress },
      );
      const output = (result as Record<string, unknown>).output ?? result;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(sanitizeOutput(output), null, 2) }],
      };
    } catch (err) {
      success = false;

      if (isDispatchError(err)) {
        const code = err.code;
        let errorMsg = err.message;

        if (code === -32001) {
          errorMsg = `Tab closed: ${errorMsg}`;
        } else if (code === -32002) {
          errorMsg = `Tab unavailable: ${errorMsg}`;
        }

        const toolErrorCode = err.data?.code;
        if (typeof toolErrorCode === 'string') {
          errorMsg = formatStructuredError(toolErrorCode, errorMsg, err.data);
        }

        return {
          content: [{ type: 'text' as const, text: errorMsg }],
          isError: true,
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Tool dispatch error: ${msg}`,
          },
        ],
        isError: true,
      };
    } finally {
      const prev = state.activeDispatches.get(foundPlugin) ?? 1;
      if (prev <= 1) {
        state.activeDispatches.delete(foundPlugin);
      } else {
        state.activeDispatches.set(foundPlugin, prev - 1);
      }
      const durationMs = Date.now() - startTs;
      log.debug('tool.call:', foundPlugin + '/' + foundTool, 'completed in', `${durationMs}ms`);
      sendInvocationEnd(state, foundPlugin, foundTool, durationMs, success);
    }
  });
};

/**
 * Create a new low-level MCP Server instance with the OpenTabs server info
 * and register handlers for tools/list and tools/call.
 */
const createMcpServer = async (state: ServerState): Promise<McpServerInstance> => {
  const ServerCtor = await getServerCtor();
  const server = new ServerCtor(
    { name: 'opentabs', version },
    {
      capabilities: {
        tools: { listChanged: true },
        logging: {},
      },
    },
  );

  registerMcpHandlers(server, state);

  return server;
};

/**
 * Notify a connected MCP client that the tool list has changed.
 * Logs a warning if the notification fails (e.g., transport in a bad state)
 * to aid debugging when a client doesn't see a tool update.
 */
const notifyToolListChanged = (server: McpServerInstance): void => {
  server.sendToolListChanged().catch((err: unknown) => {
    log.warn('Failed to notify tool list change:', err);
  });
};

/**
 * Returns the list of enabled tools for MCP tools/list responses.
 * Plugin tools are filtered by the toolConfig (disabled tools are excluded).
 * Browser tools are always included (no per-tool config gating).
 */
export const getEnabledToolsList = (
  state: ServerState,
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> => {
  const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];

  for (const plugin of state.registry.plugins.values()) {
    for (const toolDef of plugin.tools) {
      const prefixed = prefixedToolName(plugin.name, toolDef.name);
      if (!isToolEnabled(state, prefixed)) continue;
      tools.push({
        name: prefixed,
        description: trustTierPrefix(plugin.trustTier) + toolDef.description,
        inputSchema: toolDef.input_schema,
      });
    }
  }

  for (const cached of state.cachedBrowserTools) {
    tools.push({
      name: cached.name,
      description: cached.description,
      inputSchema: cached.inputSchema,
    });
  }

  return tools;
};

/** Result of checking whether a plugin tool is callable */
export interface ToolCallableOk {
  ok: true;
  pluginName: string;
  toolName: string;
}

export interface ToolCallableError {
  ok: false;
  error: string;
}

export type ToolCallableResult = ToolCallableOk | ToolCallableError;

/**
 * Check if a prefixed plugin tool name is callable: exists in the tool lookup
 * and is enabled in the tool config. Browser tools are handled separately
 * (before this check) in the tools/call handler.
 */
export const checkToolCallable = (state: ServerState, prefixedToolName: string): ToolCallableResult => {
  const lookup = state.registry.toolLookup.get(prefixedToolName);
  if (!lookup) return { ok: false, error: `Tool ${prefixedToolName} not found` };
  if (!isToolEnabled(state, prefixedToolName)) return { ok: false, error: `Tool ${prefixedToolName} is disabled` };
  return { ok: true, pluginName: lookup.pluginName, toolName: lookup.toolName };
};

export type { McpServerInstance, RequestHandlerExtra };
export { createMcpServer, registerMcpHandlers, rebuildCachedBrowserTools, notifyToolListChanged, sanitizeOutput };
