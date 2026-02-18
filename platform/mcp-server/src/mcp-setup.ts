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
import { prefixedToolName, isToolEnabled } from './state.js';
import { version } from './version.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import AjvValidator from 'ajv';
import { z } from 'zod';
import type { ServerState, CachedBrowserTool, ToolLookupEntry } from './state.js';
import type { TrustTier } from '@opentabs-dev/shared';
import type { ZodError } from 'zod';

/** Maximum concurrent tool dispatches per plugin to prevent tab performance degradation */
const MAX_CONCURRENT_DISPATCHES_PER_PLUGIN = 5;

/** Map trust tier to a human-readable prefix for MCP tool descriptions */
const trustTierPrefix = (tier: TrustTier): string => {
  switch (tier) {
    case 'official':
      return '[Official] ';
    case 'community':
      return '[Community plugin — unverified] ';
    case 'local':
      return '[Local plugin] ';
  }
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

/** The instantiated MCP server with the methods we use */
interface McpServerInstance {
  setRequestHandler: (
    schema: unknown,
    handler: (request: { params: { name: string; arguments?: Record<string, unknown> } }) => unknown,
  ) => void;
  connect: (transport: unknown) => Promise<void>;
  sendToolListChanged: () => Promise<void>;
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

/** Format a ZodError into a readable validation message listing each failing field */
const formatZodError = (err: ZodError): string => {
  const issues = err.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `Invalid arguments:\n${issues.join('\n')}`;
};

/**
 * Compile a JSON Schema into an Ajv validate function.
 * Returns a ToolLookupEntry with the validate fn and error formatter.
 * If compilation fails, validate is null and errors are logged.
 */
const compileToolValidator = (
  ajv: InstanceType<typeof AjvValidator>,
  pluginName: string,
  toolName: string,
  inputSchema: Record<string, unknown>,
): Pick<ToolLookupEntry, 'validate' | 'validationErrors'> => {
  try {
    const validate = ajv.compile(inputSchema);
    return {
      validate,
      validationErrors: () => {
        if (!validate.errors?.length) return 'Unknown validation error';
        return validate.errors
          .map(e => {
            const path = e.instancePath || '(root)';
            return `  - ${path}: ${e.message ?? 'invalid'}`;
          })
          .join('\n');
      },
    };
  } catch (err) {
    log.warn(`Failed to compile JSON Schema for ${pluginName}/${toolName}:`, err);
    return {
      validate: null,
      validationErrors: () => 'Schema compilation failed — validation skipped',
    };
  }
};

/**
 * Rebuild the O(1) tool lookup map and cached browser tool schemas on state.
 * Called after state.plugins or state.browserTools changes (during reload).
 */
const rebuildToolLookups = (state: ServerState): void => {
  // Single Ajv instance for all plugin tool schemas
  const ajv = new AjvValidator({ allErrors: true });

  // Plugin tool lookup: prefixed name → { pluginName, toolName, validate }
  const toolLookup = new Map<string, ToolLookupEntry>();
  for (const plugin of state.plugins.values()) {
    for (const toolDef of plugin.tools) {
      const prefixed = prefixedToolName(plugin.name, toolDef.name);
      const { validate, validationErrors } = compileToolValidator(ajv, plugin.name, toolDef.name, toolDef.input_schema);
      toolLookup.set(prefixed, { pluginName: plugin.name, toolName: toolDef.name, validate, validationErrors });
    }
  }
  state.toolLookup = toolLookup;

  // Browser tool schemas: pre-compute JSON Schema once per reload using
  // Zod 4's native z.toJSONSchema() which produces valid draft 2020-12.
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
  // Both plugin tool schemas and browser tool JSON schemas are pre-computed
  // in rebuildToolLookups() (called during reload), so this handler only
  // filters and collects — no schema conversion per request.
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];

    // Plugin tools (from discovered plugins)
    for (const plugin of state.plugins.values()) {
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

    // Browser tools (always enabled — no per-tool config gating).
    // JSON schemas are cached at reload time in state.cachedBrowserTools.
    for (const cached of state.cachedBrowserTools) {
      tools.push({
        name: cached.name,
        description: cached.description,
        inputSchema: cached.inputSchema,
      });
    }

    return { tools };
  });

  // Handler: tools/call — dispatch to extension or handle browser tool locally.
  // Uses pre-built lookup maps for O(1) tool resolution.
  server.setRequestHandler(CallToolRequestSchema, async request => {
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
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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

    // O(1) plugin tool lookup via pre-built map
    const lookup = state.toolLookup.get(toolName);

    if (!lookup) {
      return {
        content: [{ type: 'text' as const, text: `Tool ${toolName} not found` }],
        isError: true,
      };
    }

    const { pluginName: foundPlugin, toolName: foundTool } = lookup;

    if (!isToolEnabled(state, toolName)) {
      return {
        content: [{ type: 'text' as const, text: `Tool ${toolName} is disabled` }],
        isError: true,
      };
    }

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

    const valid = lookup.validate(args);
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

      const result = await dispatchToExtension(
        state,
        'tool.dispatch',
        { plugin: foundPlugin, tool: foundTool, input: args },
        `${foundPlugin}/${foundTool}`,
      );
      const output = (result as Record<string, unknown>).output ?? result;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
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
          errorMsg = `[${toolErrorCode}] ${errorMsg}`;
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

export type { McpServerInstance };
export { createMcpServer, registerMcpHandlers, rebuildToolLookups, notifyToolListChanged, trustTierPrefix };
