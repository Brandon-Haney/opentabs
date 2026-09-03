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
import { PODS_ACTION_VERSION, type PodsActionParams, runPodsAction } from './browser-commands/pods-actions.js';
import { type PodsBridgeParams, runPodsBridge } from './browser-commands/pods-bridge.js';
import { type PodsOpenEditorParams, runPodsOpenEditor } from './browser-commands/pods-open-editor.js';
import { MAX_INPUT_SIZE, MAX_SCRIPT_TIMEOUT_MS, SCRIPT_TIMEOUT_MS } from './constants.js';
import type { DispatchErrorData, DispatchResult } from './dispatch-helpers.js';
import { dispatchToTargetedTab, dispatchWithTabFallback, resolvePlugin } from './dispatch-helpers.js';
import type { PluginMeta } from './extension-messages.js';
import { JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS } from './json-rpc-errors.js';
import { sendToServer } from './messaging.js';
import { urlMatchesPatterns } from './tab-matching.js';

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
          details?: unknown;
        };
        if (typeof caughtError.code !== 'string') {
          return {
            type: 'error' as const,
            code: -32603,
            message: caughtError.message ?? 'Tool execution failed',
          };
        }
        const data: DispatchErrorData = { code: caughtError.code };
        if (typeof caughtError.retryable === 'boolean') data.retryable = caughtError.retryable;
        if (typeof caughtError.retryAfterMs === 'number') data.retryAfterMs = caughtError.retryAfterMs;
        if (typeof caughtError.category === 'string') data.category = caughtError.category;
        // `details` is read duck-typed off the thrown object, like the fields above.
        // executeScript requires a JSON-serializable return value: a details object
        // holding a function, cycle, or BigInt would void the ENTIRE result, so it is
        // round-tripped through JSON here and dropped if that fails. The size bound
        // keeps a huge object from crossing the world boundary only to be dropped by
        // the background; the literal mirrors MAX_DETAILS_LENGTH in sanitize-error.ts
        // (serialized closures cannot reference module constants).
        const details = caughtError.details;
        if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
          try {
            const serialized = JSON.stringify(details);
            if (typeof serialized === 'string' && serialized.length <= 4096) {
              data.details = JSON.parse(serialized) as Record<string, unknown>;
            }
          } catch {
            // Details that cannot be JSON-serialized are dropped; the rest of the error still crosses the boundary.
          }
        }
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
 * Extraction outcome for `__podsBridge`. `absent` and `malformed` are distinct so
 * a present-but-invalid directive becomes a loud error instead of passing through
 * as a raw tool output — the same contract as `__podsAction`.
 */
type PodsBridgeExtraction =
  | { kind: 'absent' }
  | { kind: 'malformed'; reason: string }
  | { kind: 'valid'; directive: PodsBridgeDirective };

/**
 * Extract a `__podsBridge` directive. Keyed on a distinct `__podsBridge` field
 * — never `__bridge` — so the two allow-lists never silently drop each other's
 * fields. Like {@link extractBridgeDirective}, the directive comes from a reviewed
 * adapter but drives an authenticated request, so every field is checked.
 */
const extractPodsBridgeDirective = (output: unknown): PodsBridgeExtraction => {
  if (!output || typeof output !== 'object') return { kind: 'absent' };
  const pods = (output as Record<string, unknown>).__podsBridge;
  if (pods === undefined) return { kind: 'absent' };
  if (!pods || typeof pods !== 'object') return { kind: 'malformed', reason: '`__podsBridge` is not an object' };
  const p = pods as Record<string, unknown>;
  if (
    typeof p.frameUrlIncludes !== 'string' ||
    typeof p.donorGlobal !== 'string' ||
    typeof p.headSentinel !== 'string'
  ) {
    return { kind: 'malformed', reason: 'frame/donor/sentinel fields must all be strings' };
  }
  if (!p.body || typeof p.body !== 'object' || Array.isArray(p.body)) {
    return { kind: 'malformed', reason: '`body` must be a plain object' };
  }
  return {
    kind: 'valid',
    directive: {
      frameUrlIncludes: p.frameUrlIncludes,
      donorGlobal: p.donorGlobal,
      headSentinel: p.headSentinel,
      body: p.body as Record<string, unknown>,
      ...(typeof p.guidToken === 'string' && p.guidToken.length > 0 ? { guidToken: p.guidToken } : {}),
      ...(typeof p.headToken === 'string' && p.headToken.length > 0 ? { headToken: p.headToken } : {}),
    },
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
  const extraction = extractPodsBridgeDirective(result.output);
  if (extraction.kind === 'absent') return result;
  if (extraction.kind === 'malformed') {
    return {
      type: 'error',
      code: JSONRPC_INVALID_PARAMS,
      message: `Malformed __podsBridge directive: ${extraction.reason}.`,
    };
  }
  const directive = extraction.directive;

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
 * Directive markers of the retired per-action pods engines. A plugin build that
 * predates the `__podsAction` engine still emits these; without recognition they
 * would pass through as raw tool outputs that read as success while writing
 * nothing — the silent stale-build no-op. Tombstoned instead: seeing one is a
 * loud "rebuild the plugin" error.
 */
const LEGACY_PODS_MARKERS = ['__podsSetFontSize', '__podsFormatText', '__podsAddSlide', '__podsDeleteSlide'] as const;

/** The legacy pods marker a tool output carries, or null. Exported for tests. */
const findLegacyPodsMarker = (output: unknown): string | null => {
  if (!output || typeof output !== 'object') return null;
  for (const marker of LEGACY_PODS_MARKERS) {
    if (marker in (output as Record<string, unknown>)) return marker;
  }
  return null;
};

/**
 * Fail loudly when a tool result carries a directive from the retired per-action
 * pods engines: the plugin build is older than this extension, and the fix is a
 * plugin rebuild (which hot-reloads the adapter), not a debugging session.
 */
const resolveLegacyPodsDirective = (result: DispatchResult): DispatchResult => {
  if (result.type !== 'success') return result;
  const marker = findLegacyPodsMarker(result.output);
  if (!marker) return result;
  return {
    type: 'error',
    code: JSONRPC_INVALID_PARAMS,
    message:
      `This plugin build emits the retired ${marker} directive, which this extension no longer runs. ` +
      'Rebuild the plugin (cd plugins/powerpoint && npm run build) so it emits __podsAction, then retry.',
  };
};

/**
 * A `__podsAction` directive: one registered live co-authoring operation — a
 * formatting or structural write, or a live read — executed by the pods action
 * engine ({@link runPodsAction}). The directive names the action and carries its
 * arguments; everything else (the model read, target resolution, revision
 * construction, confirmation) lives in the engine's per-action specs, so adding an
 * action never touches this file.
 */
interface PodsActionDirective {
  /** Directive version the plugin was built against; checked against {@link PODS_ACTION_VERSION}. */
  v: number;
  action: string;
  args: Record<string, unknown>;
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  modelReadBody: string;
  dryRun?: boolean;
  guidToken?: string;
  headToken?: string;
  errorHints?: Record<string, string>;
}

/** Most error-hint entries a directive may carry. */
const MAX_ERROR_HINTS = 16;
/** Longest hint text kept, in characters. */
const MAX_ERROR_HINT_LENGTH = 500;

/**
 * Extraction outcome. `absent` and `malformed` are distinct on purpose: a result
 * that carries the marker but fails validation must become a loud error, never
 * pass through as a raw tool output — the pass-through is exactly the silent
 * stale-build no-op this design exists to kill.
 */
type PodsActionExtraction =
  | { kind: 'absent' }
  | { kind: 'malformed'; reason: string }
  | { kind: 'valid'; directive: PodsActionDirective };

/**
 * Extract a `__podsAction` directive. Every common field is checked here; the
 * action-specific `args` object is passed through opaque and validated by the
 * action's own `parseArgs` in the engine — the per-action allow-list lives with
 * the action's knowledge, not here.
 */
const extractPodsActionDirective = (output: unknown): PodsActionExtraction => {
  if (!output || typeof output !== 'object') return { kind: 'absent' };
  const raw = (output as Record<string, unknown>).__podsAction;
  if (raw === undefined) return { kind: 'absent' };
  if (!raw || typeof raw !== 'object') return { kind: 'malformed', reason: '`__podsAction` is not an object' };
  const p = raw as Record<string, unknown>;
  if (typeof p.v !== 'number' || !Number.isInteger(p.v) || p.v < 1) {
    return { kind: 'malformed', reason: '`v` must be a positive integer' };
  }
  if (typeof p.action !== 'string' || p.action.length === 0) {
    return { kind: 'malformed', reason: '`action` must be a non-empty string' };
  }
  if (p.args !== undefined && (typeof p.args !== 'object' || p.args === null || Array.isArray(p.args))) {
    return { kind: 'malformed', reason: '`args` must be an object' };
  }
  if (
    typeof p.frameUrlIncludes !== 'string' ||
    typeof p.donorGlobal !== 'string' ||
    typeof p.headSentinel !== 'string' ||
    typeof p.modelReadBody !== 'string'
  ) {
    return { kind: 'malformed', reason: 'frame/donor/sentinel/model-read fields must all be strings' };
  }
  // A present-but-mistyped dryRun must not silently coerce to a REAL write on a
  // live deck — that inverts the field's whole purpose.
  if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') {
    return { kind: 'malformed', reason: '`dryRun` must be a boolean when present' };
  }
  // Hints are advisory plugin→agent guidance; cap them so the channel cannot be
  // stuffed with unbounded text that reads as trusted platform output.
  const errorHints: Record<string, string> = {};
  if (p.errorHints && typeof p.errorHints === 'object' && !Array.isArray(p.errorHints)) {
    for (const [key, value] of Object.entries(p.errorHints as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      errorHints[key] = value.slice(0, MAX_ERROR_HINT_LENGTH);
      if (Object.keys(errorHints).length >= MAX_ERROR_HINTS) break;
    }
  }
  return {
    kind: 'valid',
    directive: {
      v: p.v,
      action: p.action,
      args: (p.args ?? {}) as Record<string, unknown>,
      frameUrlIncludes: p.frameUrlIncludes,
      donorGlobal: p.donorGlobal,
      headSentinel: p.headSentinel,
      modelReadBody: p.modelReadBody,
      dryRun: p.dryRun === true,
      ...(typeof p.guidToken === 'string' && p.guidToken.length > 0 ? { guidToken: p.guidToken } : {}),
      ...(typeof p.headToken === 'string' && p.headToken.length > 0 ? { headToken: p.headToken } : {}),
      ...(Object.keys(errorHints).length > 0 ? { errorHints } : {}),
    },
  };
};

/**
 * When a tool result carries a `__podsAction` directive, run the pods action
 * engine on the resolved tab and replace the output with its result. A no-op when
 * the marker is absent, so it chains after {@link resolvePodsBridgeDirective}. A
 * write that did not apply comes back as `failure` and is raised to a dispatch
 * error; a malformed or too-new directive errors loudly with rebuild instructions.
 */
const resolvePodsActionDirective = async (result: DispatchResult, tabId: number): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const extraction = extractPodsActionDirective(result.output);
  if (extraction.kind === 'absent') return result;
  if (extraction.kind === 'malformed') {
    return {
      type: 'error',
      code: JSONRPC_INVALID_PARAMS,
      message:
        `Malformed __podsAction directive: ${extraction.reason}. If the plugin was just rebuilt, rebuild the ` +
        `extension too (npm run build) and reload it from chrome://extensions/ — this build speaks v${PODS_ACTION_VERSION}.`,
    };
  }

  const params: PodsActionParams = { tabId, ...extraction.directive };
  try {
    const actionResult = await runPodsAction(params);
    if ('failure' in actionResult && actionResult.failure !== undefined) {
      return {
        type: 'error',
        code: JSONRPC_INTERNAL_ERROR,
        message: String(actionResult.failure),
        data: { code: 'PODS_WRITE_FAILED', category: 'internal', retryable: false },
      };
    }
    return { type: 'success', output: actionResult };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `Pods action failed: ${toErrorMessage(err)}` };
  }
};

/** Longest editor-session wait an `__podsOpenEditor` directive may request. */
const MAX_OPEN_EDITOR_WAIT_MS = 180_000;

/**
 * A `__podsOpenEditor` directive: open a deck's web-editor URL in a new tab and
 * wait for its co-authoring session (editor frame + captured donor) to be live.
 * The engine allow-lists the URL to Office editor hosts.
 */
interface PodsOpenEditorDirective {
  url: string;
  frameUrlIncludes: string;
  donorGlobal: string;
  waitMs?: number;
}

/** Extraction outcome for `__podsOpenEditor`, with the same loud-malformed contract as `__podsAction`. */
type PodsOpenEditorExtraction =
  | { kind: 'absent' }
  | { kind: 'malformed'; reason: string }
  | { kind: 'valid'; directive: PodsOpenEditorDirective };

const extractPodsOpenEditorDirective = (output: unknown): PodsOpenEditorExtraction => {
  if (!output || typeof output !== 'object') return { kind: 'absent' };
  const raw = (output as Record<string, unknown>).__podsOpenEditor;
  if (raw === undefined) return { kind: 'absent' };
  if (!raw || typeof raw !== 'object') return { kind: 'malformed', reason: '`__podsOpenEditor` is not an object' };
  const p = raw as Record<string, unknown>;
  if (typeof p.url !== 'string' || p.url.length === 0) {
    return { kind: 'malformed', reason: '`url` must be a non-empty string' };
  }
  if (typeof p.frameUrlIncludes !== 'string' || typeof p.donorGlobal !== 'string') {
    return { kind: 'malformed', reason: '`frameUrlIncludes` and `donorGlobal` must be strings' };
  }
  const waitMs =
    typeof p.waitMs === 'number' && Number.isFinite(p.waitMs) && p.waitMs > 0
      ? Math.min(p.waitMs, MAX_OPEN_EDITOR_WAIT_MS)
      : undefined;
  return {
    kind: 'valid',
    directive: {
      url: p.url,
      frameUrlIncludes: p.frameUrlIncludes,
      donorGlobal: p.donorGlobal,
      ...(waitMs !== undefined ? { waitMs } : {}),
    },
  };
};

/**
 * When a tool result carries a `__podsOpenEditor` directive, open the deck and
 * wait for its editor session, replacing the output with the opened tab's id and
 * readiness. The dispatch tab is not involved — the engine creates its own tab —
 * so the URL is gated against the DISPATCHING plugin's own URL patterns: a plugin
 * may only open pages it is already trusted to run on. Without this, any enabled
 * plugin could spawn foreground navigations to hosts the user never associated
 * with it.
 */
const resolvePodsOpenEditorDirective = async (result: DispatchResult, plugin: PluginMeta): Promise<DispatchResult> => {
  if (result.type !== 'success') return result;
  const extraction = extractPodsOpenEditorDirective(result.output);
  if (extraction.kind === 'absent') return result;
  if (extraction.kind === 'malformed') {
    return {
      type: 'error',
      code: JSONRPC_INVALID_PARAMS,
      message: `Malformed __podsOpenEditor directive: ${extraction.reason}.`,
    };
  }
  if (!urlMatchesPatterns(extraction.directive.url, plugin.urlPatterns, plugin.excludePatterns)) {
    return {
      type: 'error',
      code: JSONRPC_INVALID_PARAMS,
      message:
        `__podsOpenEditor may only open URLs matching the "${plugin.name}" plugin's own URL patterns; ` +
        `"${extraction.directive.url}" does not.`,
    };
  }

  const params: PodsOpenEditorParams = extraction.directive;
  try {
    return { type: 'success', output: await runPodsOpenEditor(params) };
  } catch (err) {
    if (err instanceof FrameBridgeValidationError) {
      return { type: 'error', code: JSONRPC_INVALID_PARAMS, message: err.message };
    }
    return { type: 'error', code: JSONRPC_INTERNAL_ERROR, message: `open_in_editor failed: ${toErrorMessage(err)}` };
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
      const legacyChecked = resolveLegacyPodsDirective(result);
      const bridged = await resolveBridgeDirective(legacyChecked, tid);
      const podsWritten = await resolvePodsBridgeDirective(bridged, tid);
      const actioned = await resolvePodsActionDirective(podsWritten, tid);
      return await resolvePodsOpenEditorDirective(actioned, plugin);
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
  extractPodsActionDirective,
  extractPodsBridgeDirective,
  extractPodsOpenEditorDirective,
  findLegacyPodsMarker,
  getPluginLink,
  handleToolDispatch,
  notifyDispatchProgress,
};
