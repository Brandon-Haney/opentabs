/**
 * Config system — ~/.opentabs/config.json
 *
 * Single source of truth for local plugin paths and tool enabled/disabled state.
 * Created automatically on first MCP server run with sensible defaults.
 *
 * The config directory defaults to ~/.opentabs but can be overridden via the
 * OPENTABS_CONFIG_DIR environment variable. This is essential for parallel
 * E2E test execution where each test worker needs its own isolated config
 * to avoid clobbering shared state.
 */

import { log } from './logger.js';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Shape of ~/.opentabs/config.json */
interface OpentabsConfig {
  /** Filesystem paths to local plugin directories */
  plugins: string[];
  /** Tool enabled/disabled state: prefixed tool name → boolean. Absent = enabled (default). */
  tools: Record<string, boolean>;
  /** Shared secret for WebSocket authentication between MCP server and Chrome extension */
  secret?: string;
  /** npm package names explicitly allowed for npm-discovered plugins (empty = none) */
  npmPlugins?: string[];
}

/** Read the config directory, checking the environment variable on each call
 *  so that test overrides via OPENTABS_CONFIG_DIR take effect even after
 *  the module has been cached. */
const getConfigDir = (): string => Bun.env.OPENTABS_CONFIG_DIR || join(homedir(), '.opentabs');
const getConfigPath = (): string => join(getConfigDir(), 'config.json');

/** Managed extension install directory (~/.opentabs/extension/) */
const getExtensionDir = (): string => join(getConfigDir(), 'extension');

/** @public Version marker file for the managed extension install */
const getExtensionVersionFile = (): string => join(getExtensionDir(), '.opentabs-version');

/** @public Directory for plugin adapter IIFEs inside the managed extension */
const getAdaptersDir = (): string => join(getExtensionDir(), 'adapters');

/** Returned when config cannot be loaded (file corrupted, permissions error, etc.) */
const FALLBACK_CONFIG: OpentabsConfig = {
  plugins: [],
  tools: {},
  secret: undefined,
};

/**
 * Load config from ~/.opentabs/config.json.
 * Creates the directory and file with defaults if they don't exist.
 * Catches file read/parse errors — returns defaults and logs a warning.
 */
const loadConfig = async (): Promise<OpentabsConfig> => {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  try {
    await mkdir(configDir, { recursive: true });

    const configFile = Bun.file(configPath);
    if (!(await configFile.exists())) {
      // First run — create default config with a fresh shared secret
      const config: OpentabsConfig = { plugins: [], tools: {}, secret: crypto.randomUUID(), npmPlugins: [] };
      await Bun.write(configPath, JSON.stringify(config, null, 2) + '\n');
      log.info(`Created default config at ${configPath}`);
      return config;
    }

    const raw = await configFile.text();

    const parsed: unknown = JSON.parse(raw);

    // Guard against non-object JSON values (arrays, primitives, null)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn(`Config at ${configPath} is not a JSON object — using fallback`);
      return { ...FALLBACK_CONFIG, secret: crypto.randomUUID() };
    }

    const record = parsed as Record<string, unknown>;

    // Validate and normalize — filter invalid types to prevent downstream errors.
    // Paths are stored as-is (raw) so relative paths survive round-trips through saveConfig.
    // Callers that need absolute paths (e.g., discoverPlugins) resolve them at the call site.
    const plugins = Array.isArray(record.plugins)
      ? (record.plugins as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    const tools: Record<string, boolean> = {};
    if (record.tools && typeof record.tools === 'object' && !Array.isArray(record.tools)) {
      for (const [key, value] of Object.entries(record.tools as Record<string, unknown>)) {
        if (typeof value === 'boolean') {
          tools[key] = value;
        }
      }
    }
    const npmPlugins = Array.isArray(record.npmPlugins)
      ? (record.npmPlugins as unknown[]).filter((p): p is string => typeof p === 'string')
      : undefined;

    let secret = typeof record.secret === 'string' ? record.secret : undefined;

    // Generate secret if missing (upgrade from older config)
    if (!secret) {
      secret = crypto.randomUUID();
      const updated: OpentabsConfig = { plugins, tools, secret, npmPlugins };
      await Bun.write(configPath, JSON.stringify(updated, null, 2) + '\n');
      log.info(`Generated WebSocket authentication secret in ${configPath}`);
    }

    return { plugins, tools, secret, npmPlugins };
  } catch (err) {
    log.warn(`Failed to load config from ${configPath}, using fallback:`, err);
    return { ...FALLBACK_CONFIG, secret: crypto.randomUUID() };
  }
};

/**
 * Save config to ~/.opentabs/config.json.
 * Serialized via state.configWriteMutex to prevent concurrent read-modify-write
 * races. The mutex lives on ServerState so it survives bun --hot re-evaluations
 * (module-level variables reset on hot reload, but state persists on globalThis).
 */
const saveConfig = async (state: { configWriteMutex: Promise<void> }, config: OpentabsConfig): Promise<void> => {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  const prev = state.configWriteMutex;
  state.configWriteMutex = (async () => {
    await prev;
    await mkdir(configDir, { recursive: true });
    await Bun.write(configPath, JSON.stringify(config, null, 2) + '\n');
  })().catch((err: unknown) => {
    // Reset mutex so subsequent writes don't hang on a rejected promise
    state.configWriteMutex = Promise.resolve();
    log.warn(`Failed to save config to ${configPath}:`, err);
    throw err;
  });
  await state.configWriteMutex;
};

export type { OpentabsConfig };
export { loadConfig, saveConfig, getConfigDir, getExtensionDir, getExtensionVersionFile, getAdaptersDir };
