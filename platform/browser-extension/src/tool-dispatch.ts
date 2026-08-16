import { toErrorMessage } from '@opentabs-dev/shared';
import {
  asStringMap,
  type BridgePrepSelection,
  type BridgeProjection,
  type FrameBridgeRpcParams,
  FrameBridgeValidationError,
  runFrameBridgeRpc,
  toPrepSelections,
} from './browser-commands/frame-bridge-rpc.js';
import { requireStringParam } from './browser-commands/helpers.js';
import { type PodsAddSlideParams, runPodsAddSlide } from './browser-commands/pods-add-slide.js';
import { type PodsBridgeParams, runPodsBridge } from './browser-commands/pods-bridge.js';
import { type PodsDeleteSlideParams, runPodsDeleteSlide } from './browser-commands/pods-delete-slide.js';
import {
  type PodsFormatTextParams,
  type PodsSetFontSizeParams,
  runPodsFormatText,
  runPodsSetFontSize,
} from './browser-commands/pods-set-font-size.js';
import { MAX_INPUT_SIZE, MAX_SCRIPT_TIMEOUT_MS, SCRIPT_TIMEOUT_MS } from './constants.js';
import type { DispatchResult } from './dispatch-helpers.js';
import { dispatchToTargetedTab, dispatchWithTabFallback, resolvePlugin } from './dispatch-helpers.js';
import type { PluginMeta } from './extension-messages.js';
import { JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS } from './json-rpc-errors.js';
import { sendToServer } from './messaging.js';

/**
 * Per-dispatch progress callbacks — keyed by dispatchId, called by background.ts
 * when a tool:progress message arrives. Each callback resets the extension-side
 * script timeout for the corresponding dispatch.
 */
const progressCallbacks = new Map<string, () => void>();

/**
 * Notify the extension-side dispatch that a progress event arrived.
 * Called from the background message handler (tool:progress case).
 */
const notifyDispatchProgress = (dispatchId: string): void => {
  const cb = progressCallbacks.get(dispatchId);
  if (cb) cb();
};

/**
 * Get the link for console.warn logging: filesystem path for local plugins,
 * npm URL for published plugins.
 */
const getPluginLink = (plugin: PluginMeta): string => {
  if (plugin.sourcePath) {
    return plugin.sourcePath;
  }
  return `https://npmjs.com/package/${plugin.name}`;
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
        console.warn(`[opentabs] ${pName}.${tName} invoked — ${lnk}`);
      },
      args: [pluginName, toolName, link],
    });
  } catch {
    // Tab may not be injectable — logging is best-effort
  }
};

/**
 * Inject an ISOLATED world content script that listens for opentabs:progress
 * CustomEvents from the MAIN world and relays them to the background service
 * worker via chrome.runtime.sendMessage. Returns after the listener is installed.
 *
 * CustomEvents fired in MAIN world are visible in ISOLATED world because they
 * share the same DOM — this is the correct, CSP-safe pattern for cross-world
 * communication in Chrome extensions.
 */
const injectProgressListener = async (tabId: number, dispatchId: string): Promise<void> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (dId: string) => {
        const eventName = `opentabs:progress:${dId}`;
        const handler = (e: Event) => {
          const detail = (e as CustomEvent).detail as {
            dispatchId: string;
            progress: number;
            total: number;
            message?: string;
          } | null;
          if (!detail) return;
          void chrome.runtime.sendMessage({
            type: 'tool:progress',
            dispatchId: detail.dispatchId,
            progress: detail.progress,
            total: detail.total,
            message: detail.message,
          });
        };
        document.addEventListener(eventName, handler);

        // Store a cleanup function on the document so we can remove the listener later
        const cleanupKey = `__opentabs_progress_cleanup_${dId}`;
        const doc = document as unknown as Record<string, unknown>;
        doc[cleanupKey] = () => {
          document.removeEventListener(eventName, handler);
          doc[cleanupKey] = undefined;
        };
      },
      args: [dispatchId],
    });
  } catch {
    // Tab may not be injectable — progress is best-effort
  }
};

/**
 * Remove the ISOLATED world progress listener installed by injectProgressListener.
 * Fire-and-forget — errors are silently ignored since the dispatch is already complete.
 */
const removeProgressListener = (tabId: number, dispatchId: string): void => {
  chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (dId: string) => {
        const cleanupKey = `__opentabs_progress_cleanup_${dId}`;
        const cleanup = (document as unknown as Record<string, unknown>)[cleanupKey] as (() => void) | undefined;
        if (cleanup) cleanup();
      },
      args: [dispatchId],
    })
    .catch(() => {
      // Best-effort cleanup
    });
};

/**
 * Execute a tool on a specific tab. Returns the structured result from the
 * adapter script, or throws if the tab is inaccessible (e.g., closed).
 *
 * The extension-side timeout starts at SCRIPT_TIMEOUT_MS (25s). When the tool
 * reports progress, the timeout is reset via the progressCallbacks registry.
 * The absolute upper bound is MAX_SCRIPT_TIMEOUT_MS (295s).
 *
 * @param dispatchId - Correlation ID for progress reporting. The injected MAIN
 *   world function creates a ToolHandlerContext with a reportProgress callback
 *   that fires CustomEvents keyed by this ID.
 */
const executeToolOnTab = async (
  tabId: number,
  pluginName: string,
  toolName: string,
  input: Record<string, unknown>,
  dispatchId: string,
): Promise<DispatchResult> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const startTs = Date.now();

  const scriptPromise = chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (pName: string, tName: string, tInput: Record<string, unknown>, dId: string) => {
      const ot = (globalThis as Record<string, unknown>).__openTabs as
        | {
            adapters?: Record<
              string,
              {
                isReady(): Promise<boolean>;
                tools: Array<{
                  name: string;
                  handle(
                    params: unknown,
                    context?: { reportProgress(opts: { progress: number; total: number; message?: string }): void },
                  ): Promise<unknown>;
                }>;
              }
            >;
          }
        | undefined;
      const adapter = ot?.adapters?.[pName];
      if (!adapter || typeof adapter !== 'object') {
        return { type: 'error' as const, code: -32002, message: `Adapter "${pName}" not injected or not ready` };
      }

      // Defense-in-depth: reject adapters that are not frozen. Legitimate
      // adapters are always frozen by the hashAndFreeze snippet appended to
      // the IIFE. An unfrozen adapter indicates tampering by a page script.
      if (!Object.isFrozen(adapter)) {
        return {
          type: 'error' as const,
          code: -32002,
          message: `Adapter "${pName}" failed integrity check (not frozen)`,
        };
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

      // Create ToolHandlerContext with reportProgress that fires a CustomEvent
      // on the document. The ISOLATED world content script listens for this event
      // and relays it to the background service worker. Missing progress/total
      // default to 0 for indeterminate progress reporting.
      const context = {
        reportProgress(opts: { progress?: number; total?: number; message?: string }) {
          try {
            document.dispatchEvent(
              new CustomEvent(`opentabs:progress:${dId}`, {
                detail: {
                  dispatchId: dId,
                  progress: opts.progress ?? 0,
                  total: opts.total ?? 0,
                  message: opts.message,
                },
              }),
            );
          } catch {
            // Fire-and-forget — progress reporting errors must not affect tool execution
          }
        },
      };

      try {
        const output = await tool.handle(tInput, context);
        return { type: 'success' as const, output };
      } catch (err: unknown) {
        const caughtError = err as {
          message?: string;
          code?: string;
          retryable?: boolean;
          retryAfterMs?: number;
          category?: string;
        };
        if (typeof caughtError.code !== 'string') {
          return {
            type: 'error' as const,
            code: -32603,
            message: caughtError.message ?? 'Tool execution failed',
          };
        }
        const data: {
          code: string;
          retryable?: boolean;
          retryAfterMs?: number;
          category?: string;
        } = { code: caughtError.code };
        if (typeof caughtError.retryable === 'boolean') data.retryable = caughtError.retryable;
        if (typeof caughtError.retryAfterMs === 'number') data.retryAfterMs = caughtError.retryAfterMs;
        if (typeof caughtError.category === 'string') data.category = caughtError.category;
        return {
          type: 'error' as const,
          code: -32603,
          message: caughtError.message ?? 'Tool execution failed',
          data,
        };
      }
    },
    args: [pluginName, toolName, input, dispatchId],
  });

  let timeoutReject: ((err: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutReject = reject;
    timeoutId = setTimeout(() => {
      reject(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`));
    }, SCRIPT_TIMEOUT_MS);
  });

  // Register a progress callback that resets the extension-side timeout.
  // Called by background.ts when a tool:progress message arrives.
  progressCallbacks.set(dispatchId, () => {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTs;
    const remainingMax = MAX_SCRIPT_TIMEOUT_MS - elapsed;
    if (remainingMax <= 0) {
      timeoutReject?.(new Error(`Script execution exceeded absolute max timeout of ${MAX_SCRIPT_TIMEOUT_MS}ms`));
      return;
    }
    const nextTimeout = Math.min(SCRIPT_TIMEOUT_MS, remainingMax);
    timeoutId = setTimeout(() => {
      timeoutReject?.(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`));
    }, nextTimeout);
  });

  let results: Awaited<typeof scriptPromise>;
  try {
    results = await Promise.race([scriptPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    progressCallbacks.delete(dispatchId);
  }

  const firstResult = results[0] as { result?: unknown } | undefined;
  const result = firstResult?.result as DispatchResult | undefined;

  if (!result || typeof result !== 'object' || !('type' in result)) {
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: 'No result from tool execution' };
  }

  return result;
};

/**
 * A `__bridge` directive an adapter tool handler may return instead of a plain
 * result. It instructs the extension to run the frame-bridge RPC engine on the
 * same tab the tool dispatched to — the mechanism by which a plugin drives a
 * coauth-context RPC API in a cross-origin embedded frame without any CDP or
 * network code in the adapter itself. Plugin-agnostic: any plugin can emit it.
 */
interface BridgeDirective {
  method: string;
  frameUrlIncludes: string;
  harvestUrlIncludes: string;
  options?: Record<string, unknown>;
  donorGlobal?: string;
  prepMethod?: string;
  prepOptions?: Record<string, unknown>;
  /** Whether the prep response's edit-state is merged into the context (default true). */
  prepMergesContext?: boolean;
  /** Commit options resolved from the prep call's response. */
  optionsFromPrep?: BridgePrepSelection[];
  /** HTTP verb for the prep call; defaults to POST. */
  prepHttpMethod?: 'GET' | 'POST';
  /** Restrict the prep call's context to these keys — needed when it is a GET. */
  prepContextKeys?: string[];
  /** Commit options lifted verbatim from the prep response, `{ optionPath: responsePath }`. */
  optionsFromPrepPaths?: Record<string, string>;
  contextPatch?: Record<string, unknown>;
  /**
   * `{ optionName: frameGlobalName }` for option values the embedded frame owns
   * rather than the adapter — a per-session credential the app mints, for
   * instance. The engine reads them in the frame, so they never cross into the
   * host page or the adapter.
   */
  optionsFromFrameGlobals?: Record<string, string>;
  /** HTTP verb for the replayed call; defaults to POST. */
  httpMethod?: 'GET' | 'POST';
  /** Restrict the reused context to these keys — needed for GET, where it travels in the URL. */
  contextKeys?: string[];
  /** Select and reshape part of the response instead of returning the whole envelope. */
  projection?: BridgeProjection;
  /** Service error code → guidance appended when the call fails with that code. */
  errorHints?: Record<string, string>;
}

/**
 * Narrow an untrusted value to a {@link BridgeProjection}. A projection only
 * selects and renames parts of a response, so a malformed one cannot widen what
 * the request does — but a bad `path` would silently return null, so the shape
 * is checked rather than coerced.
 */
const asBridgeProjection = (value: unknown): BridgeProjection | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.path !== 'string' || p.path.length === 0) return undefined;
  const fields = asStringMap(p.fields);
  return {
    path: p.path,
    ...(fields ? { fields } : {}),
    ...(typeof p.flattenChildren === 'string' && p.flattenChildren.length > 0
      ? { flattenChildren: p.flattenChildren }
      : {}),
  };
};

/**
 * Extract a well-formed `__bridge` directive from an adapter output, or null
 * when the output is a plain result. Validates each field's type — the output
 * originates from a reviewed adapter, but the engine makes an authenticated
 * request from it, so it is validated defensively before use.
 */
const extractBridgeDirective = (output: unknown): BridgeDirective | null => {
  if (!output || typeof output !== 'object') return null;
  const bridge = (output as Record<string, unknown>).__bridge;
  if (!bridge || typeof bridge !== 'object') return null;
  const b = bridge as Record<string, unknown>;
  if (
    typeof b.method !== 'string' ||
    typeof b.frameUrlIncludes !== 'string' ||
    typeof b.harvestUrlIncludes !== 'string'
  ) {
    return null;
  }
  const options =
    b.options && typeof b.options === 'object' && !Array.isArray(b.options)
      ? (b.options as Record<string, unknown>)
      : undefined;
  const prepOptions =
    b.prepOptions && typeof b.prepOptions === 'object' && !Array.isArray(b.prepOptions)
      ? (b.prepOptions as Record<string, unknown>)
      : undefined;
  const contextPatch =
    b.contextPatch && typeof b.contextPatch === 'object' && !Array.isArray(b.contextPatch)
      ? (b.contextPatch as Record<string, unknown>)
      : undefined;
  const optionsFromPrep = toPrepSelections(b.optionsFromPrep);
  const optionsFromPrepPaths = asStringMap(b.optionsFromPrepPaths);
  const optionsFromFrameGlobals = asStringMap(b.optionsFromFrameGlobals);
  const errorHints = asStringMap(b.errorHints);
  const projection = asBridgeProjection(b.projection);
  return {
    method: b.method,
    frameUrlIncludes: b.frameUrlIncludes,
    harvestUrlIncludes: b.harvestUrlIncludes,
    ...(options ? { options } : {}),
    ...(typeof b.donorGlobal === 'string' && b.donorGlobal.length > 0 ? { donorGlobal: b.donorGlobal } : {}),
    ...(typeof b.prepMethod === 'string' && b.prepMethod.length > 0 ? { prepMethod: b.prepMethod } : {}),
    ...(prepOptions ? { prepOptions } : {}),
    ...(b.prepMergesContext === false ? { prepMergesContext: false } : {}),
    ...(optionsFromPrep ? { optionsFromPrep } : {}),
    ...(b.prepHttpMethod === 'GET' ? { prepHttpMethod: 'GET' as const } : {}),
    ...(Array.isArray(b.prepContextKeys)
      ? { prepContextKeys: b.prepContextKeys.filter((k): k is string => typeof k === 'string') }
      : {}),
    ...(optionsFromPrepPaths ? { optionsFromPrepPaths } : {}),
    ...(contextPatch ? { contextPatch } : {}),
    ...(optionsFromFrameGlobals ? { optionsFromFrameGlobals } : {}),
    ...(b.httpMethod === 'GET' ? { httpMethod: 'GET' as const } : {}),
    ...(Array.isArray(b.contextKeys)
      ? { contextKeys: b.contextKeys.filter((k): k is string => typeof k === 'string') }
      : {}),
    ...(projection ? { projection } : {}),
    ...(errorHints ? { errorHints } : {}),
  };
};

/**
 * When a tool result carries a `__bridge` directive, run the frame-bridge RPC
 * engine on the resolved tab and replace the output with the parsed engine
 * result. Otherwise return the result unchanged. This runs where the dispatch
 * tab id is already known, so the follow-up bridge call targets the same tab —
 * no second round-trip to resolve it.
 */
const resolveBridgeDirective = async (result: DispatchResult, tabId: number): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const directive = extractBridgeDirective(result.output);
  if (!directive) return result;

  const params: FrameBridgeRpcParams = { tabId, ...directive };
  try {
    const bridgeResult = await runFrameBridgeRpc(params);
    // A refused RPC answers 200 with the refusal in the payload. Reporting that
    // as a success tells the caller a write applied when it did not, so the
    // engine's verdict is raised to a dispatch error rather than left for the
    // caller to find.
    if (bridgeResult.failure !== undefined) {
      return {
        type: 'error',
        code: JSONRPC_INTERNAL_ERROR,
        message: bridgeResult.failure,
        data: { code: 'BRIDGE_RPC_FAILED', category: 'internal', retryable: false },
      };
    }
    return { type: 'success', output: bridgeResult };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `Frame bridge failed: ${toErrorMessage(err)}` };
  }
};

/**
 * A `__podsBridge` directive an adapter tool may return to write an incremental
 * revision to an open deck's co-authoring session. A sibling of `__bridge`: it
 * uses its own engine ({@link runPodsBridge}) because the pods `{Mode,srs}`
 * envelope shares nothing with EWA's `{context,…}` shape. The engine reads the
 * live head, mints a GUID, substitutes both into the body, and replays the POST
 * in the editor frame with the donor's session headers.
 */
interface PodsBridgeDirective {
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  body: Record<string, unknown>;
  guidToken?: string;
  headToken?: string;
}

/**
 * Extract a well-formed `__podsBridge` directive, or null when the output is a
 * plain result or a different directive. Keyed on a distinct `__podsBridge` field
 * — never `__bridge` — so the two allow-lists never silently drop each other's
 * fields. Like {@link extractBridgeDirective}, the directive comes from a reviewed
 * adapter but drives an authenticated request, so every field is checked.
 */
const extractPodsBridgeDirective = (output: unknown): PodsBridgeDirective | null => {
  if (!output || typeof output !== 'object') return null;
  const pods = (output as Record<string, unknown>).__podsBridge;
  if (!pods || typeof pods !== 'object') return null;
  const p = pods as Record<string, unknown>;
  if (
    typeof p.frameUrlIncludes !== 'string' ||
    typeof p.donorGlobal !== 'string' ||
    typeof p.headSentinel !== 'string' ||
    !p.body ||
    typeof p.body !== 'object' ||
    Array.isArray(p.body)
  ) {
    return null;
  }
  return {
    frameUrlIncludes: p.frameUrlIncludes,
    donorGlobal: p.donorGlobal,
    headSentinel: p.headSentinel,
    body: p.body as Record<string, unknown>,
    ...(typeof p.guidToken === 'string' && p.guidToken.length > 0 ? { guidToken: p.guidToken } : {}),
    ...(typeof p.headToken === 'string' && p.headToken.length > 0 ? { headToken: p.headToken } : {}),
  };
};

/**
 * When a tool result carries a `__podsBridge` directive, run the pods write engine
 * on the resolved tab and replace the output with the parsed result. A no-op when
 * the marker is absent (so it chains cleanly after {@link resolveBridgeDirective}).
 * A write that did not apply — a stale-base conflict or a rejection — comes back as
 * `failure`, which is raised to a dispatch error rather than reported as success,
 * so a caller is never told a write applied when it did not.
 */
const resolvePodsBridgeDirective = async (result: DispatchResult, tabId: number): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const directive = extractPodsBridgeDirective(result.output);
  if (!directive) return result;

  const params: PodsBridgeParams = { tabId, ...directive };
  try {
    const podsResult = await runPodsBridge(params);
    if (podsResult.failure !== undefined) {
      return {
        type: 'error',
        code: JSONRPC_INTERNAL_ERROR,
        message: podsResult.failure,
        data: { code: 'PODS_WRITE_FAILED', category: 'internal', retryable: false },
      };
    }
    return { type: 'success', output: podsResult };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `Pods write failed: ${toErrorMessage(err)}` };
  }
};

/**
 * A `__podsSetFontSize` directive: resize the run of a paragraph identified by its
 * visible text, in an open deck's co-authoring session. Unlike `__podsBridge`, the
 * tool cannot pre-build the body — the revision must name live, per-session object
 * ids — so the engine ({@link runPodsSetFontSize}) reads the editor's model first,
 * resolves the target, constructs the body, and then writes it.
 */
interface PodsSetFontSizeDirective {
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  text: string;
  sizePt: number;
  modelReadBody: string;
  guidToken?: string;
  headToken?: string;
}

/**
 * Extract a well-formed `__podsSetFontSize` directive, or null. Keyed on its own
 * distinct field so it never collides with `__bridge`/`__podsBridge`. Every field
 * is checked: the directive comes from a reviewed adapter but drives an
 * authenticated read-and-write against the live session.
 */
const extractPodsSetFontSizeDirective = (output: unknown): PodsSetFontSizeDirective | null => {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__podsSetFontSize;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.frameUrlIncludes !== 'string' ||
    typeof p.donorGlobal !== 'string' ||
    typeof p.headSentinel !== 'string' ||
    typeof p.text !== 'string' ||
    typeof p.sizePt !== 'number' ||
    !Number.isFinite(p.sizePt) ||
    p.sizePt <= 0 ||
    typeof p.modelReadBody !== 'string'
  ) {
    return null;
  }
  return {
    frameUrlIncludes: p.frameUrlIncludes,
    donorGlobal: p.donorGlobal,
    headSentinel: p.headSentinel,
    text: p.text,
    sizePt: p.sizePt,
    modelReadBody: p.modelReadBody,
    ...(typeof p.guidToken === 'string' && p.guidToken.length > 0 ? { guidToken: p.guidToken } : {}),
    ...(typeof p.headToken === 'string' && p.headToken.length > 0 ? { headToken: p.headToken } : {}),
  };
};

/**
 * When a tool result carries a `__podsSetFontSize` directive, run the resize engine
 * on the resolved tab and replace the output with its result. A no-op when the
 * marker is absent, so it chains after {@link resolvePodsBridgeDirective}. A write
 * that did not apply comes back as `failure` and is raised to a dispatch error.
 */
const resolvePodsSetFontSizeDirective = async (result: DispatchResult, tabId: number): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const directive = extractPodsSetFontSizeDirective(result.output);
  if (!directive) return result;

  const params: PodsSetFontSizeParams = { tabId, ...directive };
  try {
    const fontResult = await runPodsSetFontSize(params);
    if (fontResult.failure !== undefined) {
      return {
        type: 'error',
        code: JSONRPC_INTERNAL_ERROR,
        message: fontResult.failure,
        data: { code: 'PODS_WRITE_FAILED', category: 'internal', retryable: false },
      };
    }
    return { type: 'success', output: fontResult };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `set_font_size failed: ${toErrorMessage(err)}` };
  }
};

/**
 * A `__podsFormatText` directive: change a run's size, bold, italic, underline,
 * colour, and/or font on the paragraph identified by its visible text, live in the
 * open deck. Generalizes `__podsSetFontSize` — the engine reads the model, resolves
 * the run, and writes a run-format revision.
 */
interface PodsFormatTextDirective {
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  text: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  colorHex?: string;
  font?: string;
  modelReadBody: string;
  guidToken?: string;
  headToken?: string;
}

/**
 * Extract a well-formed `__podsFormatText` directive, or null. Keyed on its own
 * distinct field. At least one of size/bold/italic/underline/color/font must be
 * present, matching the engine's requirement, and every field is type-checked.
 */
const extractPodsFormatTextDirective = (output: unknown): PodsFormatTextDirective | null => {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__podsFormatText;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.frameUrlIncludes !== 'string' ||
    typeof p.donorGlobal !== 'string' ||
    typeof p.headSentinel !== 'string' ||
    typeof p.text !== 'string' ||
    typeof p.modelReadBody !== 'string'
  ) {
    return null;
  }
  const hasSize = typeof p.sizePt === 'number' && Number.isFinite(p.sizePt) && p.sizePt > 0;
  const hasBold = typeof p.bold === 'boolean';
  const hasItalic = typeof p.italic === 'boolean';
  const hasUnderline = typeof p.underline === 'boolean';
  const hasColor = typeof p.colorHex === 'string' && /^[0-9a-fA-F]{6}$/.test(p.colorHex);
  const hasFont = typeof p.font === 'string' && p.font.length > 0;
  if (!hasSize && !hasBold && !hasItalic && !hasUnderline && !hasColor && !hasFont) return null;
  return {
    frameUrlIncludes: p.frameUrlIncludes,
    donorGlobal: p.donorGlobal,
    headSentinel: p.headSentinel,
    text: p.text,
    modelReadBody: p.modelReadBody,
    ...(hasSize ? { sizePt: p.sizePt as number } : {}),
    ...(hasBold ? { bold: p.bold as boolean } : {}),
    ...(hasItalic ? { italic: p.italic as boolean } : {}),
    ...(hasUnderline ? { underline: p.underline as boolean } : {}),
    ...(hasColor ? { colorHex: (p.colorHex as string).toUpperCase() } : {}),
    ...(hasFont ? { font: p.font as string } : {}),
    ...(typeof p.guidToken === 'string' && p.guidToken.length > 0 ? { guidToken: p.guidToken } : {}),
    ...(typeof p.headToken === 'string' && p.headToken.length > 0 ? { headToken: p.headToken } : {}),
  };
};

/**
 * When a tool result carries a `__podsFormatText` directive, run the run-format
 * engine on the resolved tab and replace the output with its result. A no-op when
 * the marker is absent, so it chains after {@link resolvePodsSetFontSizeDirective}.
 * A write that did not apply comes back as `failure` and is raised to a dispatch error.
 */
const resolvePodsFormatTextDirective = async (result: DispatchResult, tabId: number): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const directive = extractPodsFormatTextDirective(result.output);
  if (!directive) return result;

  const params: PodsFormatTextParams = { tabId, ...directive };
  try {
    const formatResult = await runPodsFormatText(params);
    if (formatResult.failure !== undefined) {
      return {
        type: 'error',
        code: JSONRPC_INTERNAL_ERROR,
        message: formatResult.failure,
        data: { code: 'PODS_WRITE_FAILED', category: 'internal', retryable: false },
      };
    }
    return { type: 'success', output: formatResult };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `format_text failed: ${toErrorMessage(err)}` };
  }
};

/**
 * A `__podsAddSlide` directive: insert a new slide into the open deck via the
 * co-authoring channel. The engine reads the live root + a template slide's layout,
 * constructs the `NewSlideWithLayout` revision, and writes it (or, with `dryRun`,
 * returns it unwritten for inspection).
 */
interface PodsAddSlideDirective {
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  modelReadBody: string;
  dryRun: boolean;
  guidToken?: string;
  headToken?: string;
}

/** Extract a well-formed `__podsAddSlide` directive, or null. Keyed on its own distinct field. */
const extractPodsAddSlideDirective = (output: unknown): PodsAddSlideDirective | null => {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__podsAddSlide;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.frameUrlIncludes !== 'string' ||
    typeof p.donorGlobal !== 'string' ||
    typeof p.headSentinel !== 'string' ||
    typeof p.modelReadBody !== 'string'
  ) {
    return null;
  }
  return {
    frameUrlIncludes: p.frameUrlIncludes,
    donorGlobal: p.donorGlobal,
    headSentinel: p.headSentinel,
    modelReadBody: p.modelReadBody,
    dryRun: p.dryRun === true,
    ...(typeof p.guidToken === 'string' && p.guidToken.length > 0 ? { guidToken: p.guidToken } : {}),
    ...(typeof p.headToken === 'string' && p.headToken.length > 0 ? { headToken: p.headToken } : {}),
  };
};

/**
 * When a tool result carries a `__podsAddSlide` directive, run the add-slide engine
 * on the resolved tab and replace the output with its result. A no-op when the
 * marker is absent, so it chains after {@link resolvePodsFormatTextDirective}. A
 * write that did not apply comes back as `failure` and is raised to a dispatch error.
 */
const resolvePodsAddSlideDirective = async (result: DispatchResult, tabId: number): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const directive = extractPodsAddSlideDirective(result.output);
  if (!directive) return result;

  const params: PodsAddSlideParams = { tabId, ...directive };
  try {
    const addResult = await runPodsAddSlide(params);
    if ('failure' in addResult && addResult.failure !== undefined) {
      return {
        type: 'error',
        code: JSONRPC_INTERNAL_ERROR,
        message: addResult.failure,
        data: { code: 'PODS_WRITE_FAILED', category: 'internal', retryable: false },
      };
    }
    return { type: 'success', output: addResult };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `add_slide failed: ${toErrorMessage(err)}` };
  }
};

/**
 * A `__podsDeleteSlide` directive: remove the slide at a 1-based position from the
 * open deck via the co-authoring channel. The engine reads the live root, drops the
 * target reference from the slide list, constructs the `DeleteSlide` revision, and
 * writes it (or, with `dryRun`, returns it plus the ordered slide refs, unwritten).
 */
interface PodsDeleteSlideDirective {
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  modelReadBody: string;
  slideIndex: number;
  dryRun: boolean;
  guidToken?: string;
  headToken?: string;
}

/** Extract a well-formed `__podsDeleteSlide` directive, or null. Keyed on its own distinct field. */
const extractPodsDeleteSlideDirective = (output: unknown): PodsDeleteSlideDirective | null => {
  if (!output || typeof output !== 'object') return null;
  const raw = (output as Record<string, unknown>).__podsDeleteSlide;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.frameUrlIncludes !== 'string' ||
    typeof p.donorGlobal !== 'string' ||
    typeof p.headSentinel !== 'string' ||
    typeof p.modelReadBody !== 'string' ||
    typeof p.slideIndex !== 'number' ||
    !Number.isInteger(p.slideIndex) ||
    p.slideIndex < 1
  ) {
    return null;
  }
  return {
    frameUrlIncludes: p.frameUrlIncludes,
    donorGlobal: p.donorGlobal,
    headSentinel: p.headSentinel,
    modelReadBody: p.modelReadBody,
    slideIndex: p.slideIndex,
    dryRun: p.dryRun === true,
    ...(typeof p.guidToken === 'string' && p.guidToken.length > 0 ? { guidToken: p.guidToken } : {}),
    ...(typeof p.headToken === 'string' && p.headToken.length > 0 ? { headToken: p.headToken } : {}),
  };
};

/**
 * When a tool result carries a `__podsDeleteSlide` directive, run the delete-slide
 * engine on the resolved tab and replace the output with its result. A no-op when
 * the marker is absent, so it chains after {@link resolvePodsAddSlideDirective}. A
 * write that did not apply comes back as `failure` and is raised to a dispatch error.
 */
const resolvePodsDeleteSlideDirective = async (result: DispatchResult, tabId: number): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const directive = extractPodsDeleteSlideDirective(result.output);
  if (!directive) return result;

  const params: PodsDeleteSlideParams = { tabId, ...directive };
  try {
    const deleteResult = await runPodsDeleteSlide(params);
    if ('failure' in deleteResult && deleteResult.failure !== undefined) {
      return {
        type: 'error',
        code: JSONRPC_INTERNAL_ERROR,
        message: deleteResult.failure,
        data: { code: 'PODS_WRITE_FAILED', category: 'internal', retryable: false },
      };
    }
    return { type: 'success', output: deleteResult };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `delete_slide failed: ${toErrorMessage(err)}` };
  }
};

/**
 * Handle tool.dispatch request from MCP server.
 * Finds matching tabs, checks adapter readiness (with fallback to other
 * matching tabs when the best-ranked tab is not ready), executes the tool,
 * and returns the result.
 */
const handleToolDispatch = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  // __opentabs_dispatchId is the platform-namespaced correlation key for progress reporting,
  // injected by the MCP server. The double-underscore prefix avoids collision with plugin tool inputs.
  const dispatchId = typeof params.__opentabs_dispatchId === 'string' ? params.__opentabs_dispatchId : String(id);

  const pluginName = requireStringParam(params, 'plugin', id);
  if (!pluginName) return;

  const toolName = requireStringParam(params, 'tool', id);
  if (!toolName) return;

  const rawInput = params.input;
  if (rawInput !== undefined && rawInput !== null && (typeof rawInput !== 'object' || Array.isArray(rawInput))) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid "input" param (expected object)' },
      id,
    });
    return;
  }
  const input = (rawInput ?? {}) as Record<string, unknown>;

  let inputJson: string;
  try {
    inputJson = JSON.stringify(input);
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: {
        code: JSONRPC_INVALID_PARAMS,
        message: `Failed to serialize tool input: ${toErrorMessage(err)}`,
      },
      id,
    });
    return;
  }
  if (inputJson.length > MAX_INPUT_SIZE) {
    sendToServer({
      jsonrpc: '2.0',
      error: {
        code: JSONRPC_INVALID_PARAMS,
        message: `Tool input too large: ${(inputJson.length / 1024 / 1024).toFixed(1)}MB (limit: 10MB)`,
      },
      id,
    });
    return;
  }

  const rawTabId = params.tabId;
  const targetTabId = typeof rawTabId === 'number' && Number.isInteger(rawTabId) && rawTabId > 0 ? rawTabId : undefined;

  const plugin = await resolvePlugin(pluginName, id);
  if (!plugin) return;

  const link = getPluginLink(plugin);

  const executeOnTab = async (tid: number): Promise<DispatchResult> => {
    await injectToolInvocationLog(tid, pluginName, toolName, link);
    await injectProgressListener(tid, dispatchId);
    try {
      const result = await executeToolOnTab(tid, pluginName, toolName, input, dispatchId);
      // A tool may return a directive to drive an in-frame operation on this same
      // tab; resolve it here where the tab id is known. The two resolvers are
      // mutually exclusive — each is a no-op unless its own marker is present — so
      // chaining them lets a tool return either an EWA `__bridge` or a co-authoring
      // `__podsBridge` directive.
      const bridged = await resolveBridgeDirective(result, tid);
      const podsWritten = await resolvePodsBridgeDirective(bridged, tid);
      const fontSized = await resolvePodsSetFontSizeDirective(podsWritten, tid);
      const formatted = await resolvePodsFormatTextDirective(fontSized, tid);
      const added = await resolvePodsAddSlideDirective(formatted, tid);
      return await resolvePodsDeleteSlideDirective(added, tid);
    } finally {
      removeProgressListener(tid, dispatchId);
    }
  };

  if (targetTabId !== undefined) {
    await dispatchToTargetedTab({
      id,
      pluginName,
      plugin,
      tabId: targetTabId,
      operationName: 'tool execution',
      executeOnTab,
    });
  } else {
    await dispatchWithTabFallback({
      id,
      pluginName,
      plugin,
      operationName: 'tool execution',
      executeOnTab,
    });
  }
};

export {
  extractBridgeDirective,
  extractPodsAddSlideDirective,
  extractPodsBridgeDirective,
  extractPodsDeleteSlideDirective,
  extractPodsFormatTextDirective,
  extractPodsSetFontSizeDirective,
  getPluginLink,
  handleToolDispatch,
  notifyDispatchProgress,
};
