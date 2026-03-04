/**
 * Tool dispatch handlers for browser tools and plugin tools.
 *
 * Extracted from the monolith tools/call handler in mcp-setup.ts so each
 * dispatch path can be tested independently. The tools/call handler in
 * mcp-setup.ts delegates to these functions after resolving the tool name.
 */

import type { PluginPermissionConfig } from '@opentabs-dev/shared';
import { toErrorMessage } from '@opentabs-dev/shared';
import type { ZodError } from 'zod';
import { savePluginPermissions } from './config.js';
import {
  dispatchToExtension,
  isDispatchError,
  sendConfirmationRequest,
  sendInvocationEnd,
  sendInvocationStart,
} from './extension-protocol.js';
import { log } from './logger.js';
import { sanitizeErrorMessage } from './sanitize-error.js';
import type { AuditEntry, CachedBrowserTool, ServerState, ToolLookupEntry } from './state.js';
import { appendAuditEntry, getToolPermission } from './state.js';

/** Maximum concurrent tool dispatches per plugin to prevent tab performance degradation */
const MAX_CONCURRENT_DISPATCHES_PER_PLUGIN = 5;

/** Keys that could trigger prototype pollution in JSON deserialization */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively remove dangerous keys from objects to prevent prototype pollution
 * in MCP clients that use naive JSON deserialization.
 */
const sanitizeOutput = (obj: unknown, depth = 0): unknown => {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (depth > 50) return '[Object too deep]';
  if (Array.isArray(obj)) return obj.map(item => sanitizeOutput(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!DANGEROUS_KEYS.has(key)) result[key] = sanitizeOutput(value, depth + 1);
  }
  return result;
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

/** Result shape returned by both handleBrowserToolCall and handlePluginToolCall */
interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Extra context passed to request handlers by the MCP SDK */
interface RequestHandlerExtra {
  signal: AbortSignal;
  sessionId?: string;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: string; params?: Record<string, unknown> }) => Promise<void>;
}

/** Callbacks from the MCP setup layer for persisting config changes */
interface DispatchCallbacks {
  onToolConfigChanged: () => void;
}

/**
 * Run the 'ask' confirmation flow for a tool call.
 * Sends a confirmation request to the extension, waits for the user's decision,
 * and persists the permission change if alwaysAllow is selected.
 *
 * @returns 'allow' if the user approved, or a ToolCallResult error if denied/failed.
 */
const runAskFlow = async (
  state: ServerState,
  pluginName: string,
  toolName: string,
  params: Record<string, unknown>,
  extra: RequestHandlerExtra,
  callbacks: DispatchCallbacks,
): Promise<'allow' | ToolCallResult> => {
  // Send MCP progress notification to let the agent know we're waiting for approval
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: 0,
          total: 1,
          message: 'Waiting for user approval in the OpenTabs side panel',
        },
      })
      .catch(() => {
        // Fire-and-forget
      });
  }

  let decision: { action: 'allow' | 'deny'; alwaysAllow: boolean };
  try {
    decision = await sendConfirmationRequest(state, toolName, pluginName, params);
  } catch {
    return {
      content: [
        { type: 'text' as const, text: `Tool ${toolName} requires approval but the extension is not connected.` },
      ],
      isError: true,
    };
  }

  if (decision.action === 'deny') {
    return {
      content: [{ type: 'text' as const, text: `Tool ${toolName} was denied by the user.` }],
      isError: true,
    };
  }

  // User approved — persist to 'auto' if alwaysAllow was selected
  if (decision.alwaysAllow) {
    const existing = state.pluginPermissions[pluginName];
    const toolOverrides = { ...(existing?.tools ?? {}), [toolName]: 'auto' as const };
    const updatedConfig: PluginPermissionConfig = { ...existing, tools: toolOverrides };
    state.pluginPermissions[pluginName] = updatedConfig;
    void savePluginPermissions(state, state.pluginPermissions);
    callbacks.onToolConfigChanged();
  }

  return 'allow';
};

/**
 * Handle a browser tool call: permission check, Zod validation,
 * confirmation flow (for 'ask'), execution, output sanitization, and audit logging.
 */
const handleBrowserToolCall = async (
  state: ServerState,
  toolName: string,
  args: Record<string, unknown>,
  cachedBt: CachedBrowserTool,
  extra: RequestHandlerExtra,
  callbacks: DispatchCallbacks,
): Promise<ToolCallResult> => {
  const permission = getToolPermission(state, 'browser', toolName);

  if (permission === 'off') {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Tool ${toolName} is currently disabled. Ask the user to enable it in the OpenTabs side panel.`,
        },
      ],
      isError: true,
    };
  }

  if (permission === 'ask') {
    const askResult = await runAskFlow(state, 'browser', toolName, args, extra, callbacks);
    if (askResult !== 'allow') return askResult;
  }

  // Validate args through the tool's Zod input schema
  const parseResult = cachedBt.tool.input.safeParse(args);
  if (!parseResult.success) {
    return {
      content: [{ type: 'text' as const, text: formatZodError(parseResult.error) }],
      isError: true,
    };
  }

  // Send invocation start notification to extension (for side panel activity indicator)
  sendInvocationStart(state, 'browser', toolName);
  const btStartTs = Date.now();
  let btSuccess = true;
  let btErrorInfo: AuditEntry['error'] | undefined;
  try {
    const result = await cachedBt.tool.handler(parseResult.data, state);
    const cleaned = sanitizeOutput(result);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(cleaned, null, 2) }],
    };
  } catch (err) {
    btSuccess = false;
    const msg = toErrorMessage(err);
    btErrorInfo = { code: 'UNKNOWN', message: msg };
    return {
      content: [{ type: 'text' as const, text: `Browser tool error: ${msg}` }],
      isError: true,
    };
  } finally {
    const btDurationMs = Date.now() - btStartTs;
    sendInvocationEnd(state, 'browser', toolName, btDurationMs, btSuccess);
    appendAuditEntry(state, {
      timestamp: new Date(btStartTs).toISOString(),
      tool: toolName,
      plugin: 'browser',
      success: btSuccess,
      durationMs: btDurationMs,
      error: btErrorInfo,
    });
  }
};

/**
 * Handle a plugin tool call: permission check, Ajv validation, concurrency limiting,
 * dispatch to extension, error formatting, and audit logging.
 *
 * The caller must have already verified the tool is callable via checkToolCallable.
 */
const handlePluginToolCall = async (
  state: ServerState,
  toolName: string,
  args: Record<string, unknown>,
  pluginName: string,
  toolBaseName: string,
  lookup: ToolLookupEntry,
  extra: RequestHandlerExtra,
  callbacks: DispatchCallbacks,
): Promise<ToolCallResult> => {
  // Permission check — applies to all plugin tools
  const permission = getToolPermission(state, pluginName, toolBaseName);

  if (permission === 'off') {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Tool ${toolName} is currently disabled. Ask the user to enable it in the OpenTabs side panel.`,
        },
      ],
      isError: true,
    };
  }

  if (permission === 'ask') {
    const askResult = await runAskFlow(state, pluginName, toolBaseName, args, extra, callbacks);
    if (askResult !== 'allow') return askResult;
  }

  // Extract platform-injected tabId before validation — the plugin's own
  // schema doesn't know about tabId, so it must be stripped before Ajv runs
  // (otherwise plugins with additionalProperties: false would reject it).
  // Use destructuring instead of delete to avoid mutating the caller's object.
  const { tabId: rawTabId, ...pluginArgs } = args;
  const tabId = typeof rawTabId === 'number' && Number.isInteger(rawTabId) && rawTabId > 0 ? rawTabId : undefined;

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
    valid = lookup.validate(pluginArgs);
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
  const currentDispatches = state.activeDispatches.get(pluginName) ?? 0;
  if (currentDispatches >= MAX_CONCURRENT_DISPATCHES_PER_PLUGIN) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Too many concurrent dispatches for plugin "${pluginName}" (limit: ${MAX_CONCURRENT_DISPATCHES_PER_PLUGIN}). Wait for in-flight requests to complete.`,
        },
      ],
      isError: true,
    };
  }

  // Send invocation start notification to extension (for side panel)
  sendInvocationStart(state, pluginName, toolBaseName);
  const startTs = Date.now();
  let success = true;
  let errorInfo: AuditEntry['error'] | undefined;

  try {
    state.activeDispatches.set(pluginName, currentDispatches + 1);
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

    log.debug('tool.call: dispatching', `${pluginName}/${toolBaseName}`);

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
      { plugin: pluginName, tool: toolBaseName, input: pluginArgs, ...(tabId !== undefined && { tabId }) },
      { label: `${pluginName}/${toolBaseName}`, progressToken, onProgress },
    );
    const rawOutput = (result as Record<string, unknown>).output ?? result;
    const cleaned = sanitizeOutput(rawOutput);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(cleaned, null, 2) }],
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
      const category = typeof err.data?.category === 'string' ? err.data.category : undefined;
      if (typeof toolErrorCode === 'string') {
        errorMsg = formatStructuredError(toolErrorCode, errorMsg, err.data);
        errorInfo = { code: toolErrorCode, message: err.message, category };
      } else {
        errorInfo = { code: String(code), message: err.message };
      }

      return {
        content: [{ type: 'text' as const, text: errorMsg }],
        isError: true,
      };
    }

    const msg = sanitizeErrorMessage(toErrorMessage(err));
    errorInfo = { code: 'UNKNOWN', message: msg };
    return {
      content: [{ type: 'text' as const, text: `Tool dispatch error: ${msg}` }],
      isError: true,
    };
  } finally {
    const prev = state.activeDispatches.get(pluginName) ?? 1;
    if (prev <= 1) {
      state.activeDispatches.delete(pluginName);
    } else {
      state.activeDispatches.set(pluginName, prev - 1);
    }
    const durationMs = Date.now() - startTs;
    log.debug('tool.call:', `${pluginName}/${toolBaseName}`, 'completed in', `${durationMs}ms`);
    sendInvocationEnd(state, pluginName, toolBaseName, durationMs, success);
    appendAuditEntry(state, {
      timestamp: new Date(startTs).toISOString(),
      tool: toolName,
      plugin: pluginName,
      success,
      durationMs,
      error: errorInfo,
    });
  }
};

export type { ToolCallResult, RequestHandlerExtra, DispatchCallbacks };
export { sanitizeOutput, formatStructuredError, formatZodError, handleBrowserToolCall, handlePluginToolCall };
