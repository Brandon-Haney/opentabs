/**
 * Per-plugin circular log buffer.
 *
 * Stores the most recent log entries from plugin adapters, keyed by plugin name.
 * Each plugin gets its own fixed-size ring buffer that overwrites oldest entries
 * when full. The buffer is used for:
 *   1. Forwarding log entries to MCP clients via sendLoggingMessage
 *   2. Surfacing log counts in the /health endpoint
 */

/** Maximum log entries retained per plugin */
const MAX_ENTRIES_PER_PLUGIN = 1000;

/** A single buffered plugin log entry */
interface PluginLogEntry {
  level: string;
  plugin: string;
  message: string;
  data: unknown;
  ts: string;
}

/** Fixed-size ring buffer for log entries */
interface RingBuffer {
  entries: Array<PluginLogEntry | undefined>;
  writeIndex: number;
  size: number;
}

const createRingBuffer = (): RingBuffer => ({
  entries: new Array<PluginLogEntry | undefined>(MAX_ENTRIES_PER_PLUGIN).fill(undefined),
  writeIndex: 0,
  size: 0,
});

/** Per-plugin ring buffers */
const buffers = new Map<string, RingBuffer>();

/** Append a log entry to a plugin's ring buffer */
const appendLog = (plugin: string, entry: PluginLogEntry): void => {
  let ring = buffers.get(plugin);
  if (!ring) {
    ring = createRingBuffer();
    buffers.set(plugin, ring);
  }

  ring.entries[ring.writeIndex] = entry;
  ring.writeIndex = (ring.writeIndex + 1) % MAX_ENTRIES_PER_PLUGIN;
  if (ring.size < MAX_ENTRIES_PER_PLUGIN) {
    ring.size++;
  }
};

/**
 * Retrieve recent log entries for a plugin, oldest first.
 * Returns at most `limit` entries (defaults to all buffered entries).
 */
const getLogs = (plugin: string, limit?: number): PluginLogEntry[] => {
  const ring = buffers.get(plugin);
  if (!ring || ring.size === 0) return [];

  const cap = limit !== undefined && limit < ring.size ? limit : ring.size;
  const result: PluginLogEntry[] = [];

  // Read from oldest to newest. When the buffer has wrapped, oldest is at writeIndex.
  const startIndex = ring.size < MAX_ENTRIES_PER_PLUGIN ? 0 : ring.writeIndex;
  const skip = ring.size - cap;

  for (let i = 0; i < ring.size; i++) {
    if (i < skip) continue;
    const idx = (startIndex + i) % MAX_ENTRIES_PER_PLUGIN;
    const entry = ring.entries[idx];
    if (entry) result.push(entry);
  }

  return result;
};

/** Get the number of buffered entries for a plugin */
const getLogCount = (plugin: string): number => buffers.get(plugin)?.size ?? 0;

/** Get all plugin names that have buffered entries */
const getBufferedPlugins = (): string[] => Array.from(buffers.keys());

/** Clear all buffered entries (used during testing or state reset) */
const clearAllLogs = (): void => {
  buffers.clear();
};

export { appendLog, clearAllLogs, getBufferedPlugins, getLogCount, getLogs };
export type { PluginLogEntry };
