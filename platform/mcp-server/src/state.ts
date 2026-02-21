/**
 * In-memory state for the MCP server.
 * Tracks plugins, tab-to-plugin mapping, tool config, and pending dispatches.
 *
 * Fields that must survive hot reload (file watcher handles, timers) are stored
 * here rather than at module scope, because module-level variables reset to
 * fresh empty instances on each bun --hot re-evaluation.
 */

import type { BrowserToolDefinition } from './browser-tools/definition.js';
import type { TabState, TrustTier, ManifestTool, WsHandle } from '@opentabs-dev/shared';
import type { FSWatcher } from 'node:fs';

/** Timeout for tool dispatch and browser command requests (ms) */
export const DISPATCH_TIMEOUT_MS = 30_000;

/** Active file watcher entry for a single plugin directory */
export interface FileWatcherEntry {
  pluginDir: string;
  pluginName: string;
  watchers: FSWatcher[];
  /** Last-seen mtime (ms) for each watched file path — used by mtime polling fallback */
  lastSeenMtimes: Map<string, number>;
}

/** Plugin registered in the server */
export interface RegisteredPlugin {
  name: string;
  version: string;
  displayName: string;
  urlPatterns: string[];
  trustTier: TrustTier;
  iife: string;
  tools: ManifestTool[];
  /** SHA-256 hex hash of the adapter IIFE content (from manifest, set by `opentabs-plugin build`) */
  adapterHash?: string;
  /** Filesystem path for local plugins (used for file watching) */
  sourcePath?: string;
  /** Original npm package name (e.g., 'opentabs-plugin-slack') — only for npm-installed plugins */
  npmPackageName?: string;
}

/** Tab mapping entry for a plugin */
export interface TabMapping {
  state: TabState;
  tabId: number | null;
  url: string | null;
}

/** Pending dispatch awaiting extension response (tool.dispatch or browser.*) */
export interface PendingDispatch {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Human-readable label for timeout error messages (e.g., "slack/send_message" or "browser.openTab") */
  label: string;
  startTs: number;
  /** Timer ID for the dispatch timeout — cleared when the dispatch settles */
  timerId: ReturnType<typeof setTimeout>;
}

/** Resolved tool lookup entry for O(1) dispatch in tools/call */
export interface ToolLookupEntry {
  pluginName: string;
  toolName: string;
  /** Pre-compiled JSON Schema validator for input args. Null if schema compilation failed. */
  validate: ((data: unknown) => boolean) | null;
  /** Human-readable validation errors from the last validate() call */
  validationErrors: () => string;
}

/** Cached browser tool entry with pre-computed JSON Schema */
export interface CachedBrowserTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tool: BrowserToolDefinition;
}

/** Tool config: maps prefixed tool name → enabled boolean */
export type ToolConfig = Record<string, boolean>;

/** A plugin path that failed discovery, with a human-readable error */
export interface FailedPlugin {
  path: string;
  error: string;
}

/** Info about an outdated npm plugin */
export interface OutdatedPlugin {
  name: string;
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
}

/**
 * Immutable registry of discovered plugins.
 *
 * Holds all successfully loaded plugins, a pre-built O(1) tool lookup map
 * with compiled Ajv validators, and a list of discovery failures. Built once
 * per reload cycle and swapped atomically on ServerState.
 */
export interface PluginRegistry {
  /** All successfully loaded plugins, keyed by internal plugin name */
  readonly plugins: ReadonlyMap<string, RegisteredPlugin>;
  /** O(1) tool lookup: prefixed tool name → plugin/tool names + validator */
  readonly toolLookup: ReadonlyMap<string, ToolLookupEntry>;
  /** Plugin paths that failed discovery */
  readonly failures: readonly FailedPlugin[];
}

/** Server state singleton — shared across hot reloads via globalThis */
export interface ServerState {
  /**
   * Schema version for detecting structural changes across hot reloads.
   * If a developer changes the shape of an existing field (e.g., Map → Array),
   * bumping this version triggers a warning on the next hot reload indicating
   * a process restart is needed for full consistency.
   */
  _schemaVersion: number;
  /** Immutable plugin registry — replaced atomically on each reload */
  registry: PluginRegistry;
  /** Tab-to-plugin mapping from extension */
  tabMapping: Map<string, TabMapping>;
  /** Tool enabled/disabled config (in-memory, synced from ~/.opentabs/config.json) */
  toolConfig: ToolConfig;
  /** Local plugin paths from config */
  pluginPaths: string[];
  /** Pending tool dispatches keyed by JSON-RPC id */
  pendingDispatches: Map<string | number, PendingDispatch>;
  /** Extension WebSocket connection (single connection) */
  extensionWs: WsHandle | null;
  /** Outdated npm plugins detected on startup */
  outdatedPlugins: OutdatedPlugin[];
  /** Browser tools — updated on each hot reload so existing session handlers see fresh definitions */
  browserTools: BrowserToolDefinition[];
  /** Active file watcher entries — stored on state so hot reload can clean up the previous iteration's handles */
  fileWatcherEntries: FileWatcherEntry[];
  /** File watcher debounce timers — stored on state so hot reload can clear them */
  fileWatcherTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Shared secret for WebSocket authentication (loaded from config) */
  wsSecret: string | null;
  /** Cached browser tools with pre-computed JSON Schema. Rebuilt on each reload. */
  cachedBrowserTools: CachedBrowserTool[];
  /** Maps each MCP session server to its transport ID for accurate stale session sweeping */
  sessionTransportIds: WeakMap<object, string>;
  /** Async write mutex for config file — stored on state so it survives hot reload */
  configWriteMutex: Promise<void>;
  /** Per-plugin active dispatch count for concurrency limiting */
  activeDispatches: Map<string, number>;
  /** Periodic timer for sweeping stale MCP sessions between hot reloads */
  sweepTimerId: ReturnType<typeof setInterval> | null;
  /** Timestamp (ms since epoch) when the server process first started — survives hot reloads */
  startedAt: number;
  /** Generation counter for file watchers — incremented each time startFileWatching runs.
   *  Debounce callbacks capture the current generation and bail out if it has changed,
   *  preventing stale closures from the previous module evaluation from executing. */
  fileWatcherGeneration: number;
  /** FSWatcher for ~/.opentabs/ directory, detecting config.json changes */
  configWatcher: FSWatcher | null;
  /** Last-seen mtime (ms) of ~/.opentabs/config.json — used by mtime polling fallback */
  configLastSeenMtime: number | null;
  /** Timer ID for periodic mtime polling — cleared by stopFileWatching */
  mtimePollTimerId: ReturnType<typeof setInterval> | null;
  /** Timestamp (ms since epoch) of the last mtime polling tick, or null if polling hasn't run yet */
  mtimeLastPollAt: number | null;
  /** Running count of times mtime polling detected a change that fs.watch missed */
  mtimePollDetections: number;
  /** Timestamps (ms since epoch) of recent mtime poll detections — used for stale watcher warning */
  mtimePollDetectionTimestamps: number[];
  /** Discovery errors from the most recent reload — used by config.getState for the side panel */
  discoveryErrors: ReadonlyArray<{ specifier: string; error: string }>;
}

/** Increment when changing the type of an existing ServerState field */
export const STATE_SCHEMA_VERSION = 2;

/** Frozen empty registry for initializing ServerState */
export const EMPTY_REGISTRY: PluginRegistry = Object.freeze({
  plugins: new Map<string, RegisteredPlugin>(),
  toolLookup: new Map<string, ToolLookupEntry>(),
  failures: [] as FailedPlugin[],
});

export const createState = (): ServerState => ({
  _schemaVersion: STATE_SCHEMA_VERSION,
  registry: EMPTY_REGISTRY,
  tabMapping: new Map(),
  toolConfig: {},
  pluginPaths: [],
  pendingDispatches: new Map(),
  extensionWs: null,
  outdatedPlugins: [],
  browserTools: [],
  fileWatcherEntries: [],
  fileWatcherTimers: new Map(),
  wsSecret: null,
  cachedBrowserTools: [],
  sessionTransportIds: new WeakMap(),
  configWriteMutex: Promise.resolve(),
  activeDispatches: new Map(),
  sweepTimerId: null,
  startedAt: Date.now(),
  fileWatcherGeneration: 0,
  configWatcher: null,
  configLastSeenMtime: null,
  mtimePollTimerId: null,
  mtimeLastPollAt: null,
  mtimePollDetections: 0,
  mtimePollDetectionTimestamps: [],
  discoveryErrors: [],
});

/** Generate a cryptographically random JSON-RPC request ID */
export const getNextRequestId = (): string => crypto.randomUUID();

/** Get the prefixed tool name: plugin_tool */
export const prefixedToolName = (plugin: string, tool: string): string => `${plugin}_${tool}`;

/** Check if a tool is enabled in config. Tools are enabled by default — only
 *  explicitly disabled tools (set to false) are hidden from MCP clients. */
export const isToolEnabled = (state: ServerState, prefixedName: string): boolean =>
  state.toolConfig[prefixedName] !== false;
