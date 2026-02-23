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
import { atomicWrite, generateSecret, getConfigDir, getConfigPath, getExtensionDir } from '@opentabs-dev/shared';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shape of ~/.opentabs/config.json
 *
 * `localPlugins` holds local filesystem paths to plugin directories. These paths
 * start with `./`, `../`, `/`, or `~/` and are resolved relative to the config
 * directory. npm plugins are auto-discovered from global node_modules.
 */
/** Permission policy for a tool: allow (no confirmation), ask (require confirmation), deny (block) */
type ToolPermission = 'allow' | 'ask' | 'deny';

/** Permission configuration for browser tool confirmation */
interface PermissionsConfig {
  /** Domains where all tools are auto-allowed (supports glob patterns, e.g., '*.example.com') */
  trustedDomains: string[];
  /** Domains where all tools require confirmation regardless of tier (supports glob patterns) */
  sensitiveDomains: string[];
  /** Per-tool policy overrides: browser tool name → permission */
  toolPolicy: Record<string, ToolPermission>;
  /** Per-domain per-tool policy overrides: domain → { tool name → permission } */
  domainToolPolicy: Record<string, Record<string, ToolPermission>>;
}

interface OpentabsConfig {
  /** Local plugin directory paths (resolved relative to the config directory) */
  localPlugins: string[];
  /** Tool enabled/disabled state: prefixed tool name → boolean. Absent = enabled (default). */
  tools: Record<string, boolean>;
  /** Browser tool enabled/disabled state: browser tool name → boolean. Absent = enabled (default). */
  browserToolPolicy: Record<string, boolean>;
  /** Permission configuration for browser tool confirmation */
  permissions: PermissionsConfig;
  /** Whether to skip all confirmation prompts (dangerous — disables human-in-the-loop) */
  skipConfirmation?: boolean;

  /** Shared secret for WebSocket authentication between MCP server and Chrome extension */
  secret?: string;
}

/** Version marker file for the managed extension install */
const getExtensionVersionFile = (): string => join(getExtensionDir(), '.opentabs-version');

/** Directory for plugin adapter IIFEs inside the managed extension */
const getAdaptersDir = (): string => join(getExtensionDir(), 'adapters');

/** Write config atomically with restrictive permissions via the shared helper. */
const atomicWriteConfig = (configPath: string, content: string): Promise<void> =>
  atomicWrite(configPath, content, 0o600);

/**
 * Read and parse config.json with retry and exponential backoff.
 *
 * Handles transient file unavailability during non-atomic writes from
 * external processes (CLI commands, manual edits). Retries up to 3 times
 * with 100ms / 200ms / 400ms delays before giving up.
 *
 * Returns the raw parsed JSON or null if the file cannot be read after
 * all retries. Callers decide how to handle the failure.
 */
const readConfigWithRetry = async (
  configPath: string,
  maxRetries = 3,
  initialDelayMs = 100,
): Promise<Record<string, unknown> | null> => {
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await Bun.file(configPath).text();
      const parsed: unknown = JSON.parse(raw);

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        if (attempt === maxRetries) {
          log.warn(`Config at ${configPath} is not a JSON object after ${maxRetries + 1} attempt(s)`);
          return null;
        }
        log.debug(`Config at ${configPath} is not a JSON object — retrying (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }

      return parsed as Record<string, unknown>;
    } catch (err) {
      if (attempt === maxRetries) {
        log.warn(`Failed to read config from ${configPath} after ${maxRetries + 1} attempt(s):`, err);
        return null;
      }
      log.debug(`Config read attempt ${attempt + 1} failed, retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
  return null;
};

/** Check whether a string looks like a local filesystem path. */
const isLocalPathEntry = (s: string): boolean =>
  s.startsWith('./') ||
  s.startsWith('.\\') ||
  s.startsWith('../') ||
  s.startsWith('..\\') ||
  s.startsWith('/') ||
  s.startsWith('~/') ||
  /^[A-Za-z]:[/\\]/.test(s);

const VALID_TOOL_PERMISSIONS = new Set<string>(['allow', 'ask', 'deny']);

const isToolPermission = (v: unknown): v is ToolPermission => typeof v === 'string' && VALID_TOOL_PERMISSIONS.has(v);

/** Default permissions config: trust localhost, everything else uses tier defaults */
const defaultPermissions = (): PermissionsConfig => ({
  trustedDomains: ['localhost', '127.0.0.1'],
  sensitiveDomains: [],
  toolPolicy: {},
  domainToolPolicy: {},
});

/** Parse a raw permissions value from config.json into a validated PermissionsConfig */
const parsePermissionsConfig = (raw: unknown): PermissionsConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultPermissions();
  }
  const obj = raw as Record<string, unknown>;

  const trustedDomains = Array.isArray(obj.trustedDomains)
    ? (obj.trustedDomains as unknown[]).filter((d): d is string => typeof d === 'string')
    : ['localhost', '127.0.0.1'];

  const sensitiveDomains = Array.isArray(obj.sensitiveDomains)
    ? (obj.sensitiveDomains as unknown[]).filter((d): d is string => typeof d === 'string')
    : [];

  const toolPolicy: Record<string, ToolPermission> = {};
  if (obj.toolPolicy && typeof obj.toolPolicy === 'object' && !Array.isArray(obj.toolPolicy)) {
    for (const [key, value] of Object.entries(obj.toolPolicy as Record<string, unknown>)) {
      if (isToolPermission(value)) {
        toolPolicy[key] = value;
      }
    }
  }

  const domainToolPolicy: Record<string, Record<string, ToolPermission>> = {};
  if (obj.domainToolPolicy && typeof obj.domainToolPolicy === 'object' && !Array.isArray(obj.domainToolPolicy)) {
    for (const [domain, tools] of Object.entries(obj.domainToolPolicy as Record<string, unknown>)) {
      if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
        const domainEntry: Record<string, ToolPermission> = {};
        for (const [toolName, perm] of Object.entries(tools as Record<string, unknown>)) {
          if (isToolPermission(perm)) {
            domainEntry[toolName] = perm;
          }
        }
        if (Object.keys(domainEntry).length > 0) {
          domainToolPolicy[domain] = domainEntry;
        }
      }
    }
  }

  return { trustedDomains, sensitiveDomains, toolPolicy, domainToolPolicy };
};

/**
 * Parse a raw config record into an OpentabsConfig.
 * Validates and normalizes field types to prevent downstream errors.
 */
const parseConfigRecord = (record: Record<string, unknown>): Omit<OpentabsConfig, 'secret'> & { secret?: string } => {
  const localPlugins = Array.isArray(record.localPlugins)
    ? (record.localPlugins as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const tools: Record<string, boolean> = {};
  if (record.tools && typeof record.tools === 'object' && !Array.isArray(record.tools)) {
    for (const [key, value] of Object.entries(record.tools as Record<string, unknown>)) {
      if (typeof value === 'boolean') {
        tools[key] = value;
      }
    }
  }

  const browserToolPolicy: Record<string, boolean> = {};
  if (
    record.browserToolPolicy &&
    typeof record.browserToolPolicy === 'object' &&
    !Array.isArray(record.browserToolPolicy)
  ) {
    for (const [key, value] of Object.entries(record.browserToolPolicy as Record<string, unknown>)) {
      if (typeof value === 'boolean') {
        browserToolPolicy[key] = value;
      }
    }
  }

  // Migration: if the old `plugins` array exists, extract local paths into localPlugins
  // and drop npm package names (they will be auto-discovered from global node_modules).
  if (Array.isArray(record.plugins)) {
    const legacyPlugins = (record.plugins as unknown[]).filter((p): p is string => typeof p === 'string');
    const localPaths = legacyPlugins.filter(isLocalPathEntry);
    const npmPackages = legacyPlugins.filter(p => !isLocalPathEntry(p));

    if (localPaths.length > 0) {
      // Merge into localPlugins, deduplicating
      const existing = new Set(localPlugins);
      for (const p of localPaths) {
        if (!existing.has(p)) {
          localPlugins.push(p);
          existing.add(p);
        }
      }
      log.info(
        `Migrating ${localPaths.length} local path(s) from "plugins" to "localPlugins". ` +
          'Update your config.json to use "localPlugins" for local plugin paths.',
      );
    }
    if (npmPackages.length > 0) {
      log.info(
        `Dropping ${npmPackages.length} npm package name(s) from legacy "plugins" array. ` +
          'npm plugins are now auto-discovered from global node_modules.',
      );
    }
  }

  // Migration: merge legacy npmPlugins — these are npm packages that will be auto-discovered,
  // so they are dropped with a notice.
  if (Array.isArray(record.npmPlugins)) {
    const legacyNpm = (record.npmPlugins as unknown[]).filter((p): p is string => typeof p === 'string');
    if (legacyNpm.length > 0) {
      log.info(
        `Dropping ${legacyNpm.length} npmPlugins entry/entries. ` +
          'npm plugins are now auto-discovered from global node_modules.',
      );
    }
  }

  // Parse permissions config with defensive validation
  const permissions = parsePermissionsConfig(record.permissions);

  const skipConfirmation = typeof record.skipConfirmation === 'boolean' ? record.skipConfirmation : undefined;
  const secret = typeof record.secret === 'string' ? record.secret : undefined;

  return { localPlugins, tools, browserToolPolicy, permissions, skipConfirmation, secret };
};

/**
 * Load config from ~/.opentabs/config.json.
 * Creates the directory and file with defaults if they don't exist.
 *
 * On transient read/parse errors (corrupted file, mid-write from another
 * process), retries with exponential backoff. If all retries fail, throws
 * an error so the caller (reloadCore) can preserve previous state instead
 * of replacing it with an empty config.
 */
const loadConfig = async (): Promise<OpentabsConfig> => {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const configFile = Bun.file(configPath);
  if (!(await configFile.exists())) {
    // First run — create default config with a fresh shared secret
    const config: OpentabsConfig = {
      localPlugins: [],
      tools: {},
      browserToolPolicy: {},
      permissions: defaultPermissions(),
      secret: generateSecret(),
    };
    await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
    log.info(`Created default config at ${configPath}`);
    return config;
  }

  const record = await readConfigWithRetry(configPath);
  if (!record) {
    // All retries exhausted — throw so the caller can preserve previous state.
    // This prevents the old behavior of returning an empty fallback config
    // which would wipe all plugins from state on any transient read error.
    throw new Error(`Config at ${configPath} is unreadable after retries`);
  }

  const config = parseConfigRecord(record);
  let { secret } = config;

  // Generate secret if missing (upgrade from older config)
  if (!secret) {
    secret = generateSecret();
    const updated: OpentabsConfig = { ...config, secret };
    await atomicWriteConfig(configPath, JSON.stringify(updated, null, 2) + '\n');
    log.info(`Generated WebSocket authentication secret in ${configPath}`);
  }

  return { ...config, secret } as OpentabsConfig;
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
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
  })().catch((err: unknown) => {
    // Reset mutex so subsequent writes don't hang on a rejected promise
    state.configWriteMutex = Promise.resolve();
    log.warn(`Failed to save config to ${configPath}:`, err);
    throw err;
  });
  await state.configWriteMutex;
};

/**
 * Persist only the tool enabled/disabled state to config.json.
 *
 * Reads the current config from disk, updates only the `tools` field,
 * and writes it back atomically. This prevents stale in-memory plugin
 * paths from overwriting externally-added plugins — the root cause of
 * the "plugin disappears during development" bug.
 *
 * The read-modify-write is serialized via state.configWriteMutex.
 */
const saveToolConfig = async (
  state: { configWriteMutex: Promise<void> },
  tools: Record<string, boolean>,
): Promise<void> => {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  const prev = state.configWriteMutex;
  state.configWriteMutex = (async () => {
    await prev;
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    // Read current config from disk to preserve localPlugins and secret
    const record = await readConfigWithRetry(configPath, 2, 50);
    if (!record) {
      log.warn('Cannot persist tool config — config file unreadable');
      return;
    }

    const current = parseConfigRecord(record);
    const updated: OpentabsConfig = {
      localPlugins: current.localPlugins,
      tools,
      browserToolPolicy: current.browserToolPolicy,
      permissions: current.permissions,
      skipConfirmation: current.skipConfirmation,
      secret: current.secret,
    };
    await atomicWriteConfig(configPath, JSON.stringify(updated, null, 2) + '\n');
  })().catch((err: unknown) => {
    state.configWriteMutex = Promise.resolve();
    log.warn(`Failed to save tool config to ${configPath}:`, err);
    throw err;
  });
  await state.configWriteMutex;
};

/**
 * Write auth.json to the managed extension directory so the Chrome extension
 * can bootstrap the shared secret without an unauthenticated HTTP request.
 * Called on every reload so the port and secret stay in sync with the running server.
 */
const writeAuthFile = async (secret: string, port: number): Promise<void> => {
  const extensionDir = getExtensionDir();
  await mkdir(extensionDir, { recursive: true });
  const authPath = join(extensionDir, 'auth.json');
  await atomicWrite(authPath, JSON.stringify({ secret, port }) + '\n', 0o600);
};

export type { OpentabsConfig, PermissionsConfig, ToolPermission };
export {
  loadConfig,
  saveConfig,
  saveToolConfig,
  writeAuthFile,
  getConfigDir,
  getExtensionDir,
  getExtensionVersionFile,
  getAdaptersDir,
};
