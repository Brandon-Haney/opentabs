/**
 * Plugin management operations for the extension WebSocket protocol.
 *
 * Handles npm registry search, plugin installation, name normalization,
 * and validation. These operations are invoked via JSON-RPC methods
 * from the side panel (relayed through the Chrome extension).
 */

import { log } from './logger.js';
import { platformExec } from '@opentabs-dev/shared';
import type { ServerState } from './state.js';

// ---------------------------------------------------------------------------
// npm registry types
// ---------------------------------------------------------------------------

interface NpmSearchPackage {
  name: string;
  description?: string;
  version: string;
  publisher?: { username: string };
}

interface NpmSearchResult {
  objects: Array<{ package: NpmSearchPackage }>;
}

// ---------------------------------------------------------------------------
// Search result type returned to callers
// ---------------------------------------------------------------------------

interface PluginSearchResult {
  name: string;
  description: string;
  version: string;
  author: string;
  isOfficial: boolean;
}

// ---------------------------------------------------------------------------
// Install result type returned to callers
// ---------------------------------------------------------------------------

interface PluginInstallResult {
  ok: true;
  plugin: {
    name: string;
    displayName: string;
    version: string;
    toolCount: number;
  };
}

// ---------------------------------------------------------------------------
// Name normalization and validation
// ---------------------------------------------------------------------------

/**
 * Normalize a shorthand plugin name to its full npm package name.
 * "slack" → "opentabs-plugin-slack", scoped and full names pass through.
 */
const normalizePluginName = (name: string): string => {
  if (name.startsWith('@') || name.startsWith('opentabs-plugin-')) return name;
  return `opentabs-plugin-${name}`;
};

/**
 * Validate that a normalized package name matches the opentabs plugin naming convention.
 * Accepts `opentabs-plugin-*` and `@scope/opentabs-plugin-*` patterns.
 */
const isValidPluginPackageName = (name: string): boolean => {
  if (name.startsWith('@')) {
    return /^@[^/]+\/opentabs-plugin-.+$/.test(name);
  }
  return name.startsWith('opentabs-plugin-') && name.length > 'opentabs-plugin-'.length;
};

// ---------------------------------------------------------------------------
// npm subprocess timeout (60 seconds)
// ---------------------------------------------------------------------------

const NPM_SUBPROCESS_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// npm registry search
// ---------------------------------------------------------------------------

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';

/**
 * Search the npm registry for opentabs plugins.
 * Returns up to 20 results matching `keywords:opentabs-plugin` + optional query.
 *
 * @throws Error with `code` property for structured JSON-RPC error handling:
 *   - code -32603: registry unreachable or unexpected error
 *   - code -32603 with retryAfterMs: rate limited (HTTP 429)
 */
const searchNpmPlugins = async (query?: string): Promise<PluginSearchResult[]> => {
  const params = new URLSearchParams({
    text: query ? `keywords:opentabs-plugin ${query}` : 'keywords:opentabs-plugin',
    size: '20',
  });

  let response: Response;
  try {
    response = await fetch(`${NPM_SEARCH_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    const error = new Error('npm registry unreachable') as Error & { code: number };
    error.code = -32603;
    throw error;
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
    const error = new Error('npm registry rate limited') as Error & { code: number; retryAfterMs: number };
    error.code = -32603;
    error.retryAfterMs = retryAfterMs;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`npm registry returned HTTP ${response.status}`) as Error & { code: number };
    error.code = -32603;
    throw error;
  }

  const data = (await response.json()) as NpmSearchResult;

  return data.objects.map(({ package: pkg }) => ({
    name: pkg.name,
    description: pkg.description ?? '',
    version: pkg.version,
    author: pkg.publisher?.username ?? 'unknown',
    isOfficial: pkg.name.startsWith('@opentabs-dev/'),
  }));
};

// ---------------------------------------------------------------------------
// Plugin installation via npm
// ---------------------------------------------------------------------------

/**
 * Install a plugin from npm globally and trigger server rediscovery.
 *
 * @param name - Plugin name (shorthand or full npm package name)
 * @param state - Server state (used to look up installed plugin after rediscovery)
 * @param onReload - Callback to trigger plugin rediscovery
 * @returns Install result with plugin metadata
 *
 * @throws Error with `code` property for structured JSON-RPC error handling:
 *   - code -32602: invalid params or naming convention violation
 *   - code -32603: npm install failure
 */
const installPlugin = async (
  name: string,
  state: ServerState,
  onReload: () => Promise<{ plugins: number; durationMs: number }>,
): Promise<PluginInstallResult> => {
  const pkg = normalizePluginName(name);

  if (!isValidPluginPackageName(pkg)) {
    const error = new Error(
      `Invalid plugin name: "${pkg}" does not match opentabs-plugin-* or @scope/opentabs-plugin-* pattern`,
    ) as Error & { code: number };
    error.code = -32602;
    throw error;
  }

  log.info(`Installing plugin: ${pkg}`);

  const proc = Bun.spawn([platformExec('npm'), 'install', '-g', pkg], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeoutId = setTimeout(() => {
    proc.kill();
  }, NPM_SUBPROCESS_TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timeoutId);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    log.error(`npm install failed for ${pkg}: exit code ${exitCode}, stderr: ${stderr}`);
    const error = new Error(`npm install failed (exit code ${exitCode})`) as Error & {
      code: number;
      data: { stderr: string; stdout: string };
    };
    error.code = -32603;
    error.data = { stderr, stdout };
    throw error;
  }

  log.info(`npm install succeeded for ${pkg}, triggering rediscovery`);

  // Trigger rediscovery so the new plugin appears in the registry
  await onReload();

  // Find the newly installed plugin in the refreshed registry.
  // Match by npm package name or by plugin name derived from the package name.
  const segments = pkg.startsWith('@') ? pkg.split('/') : undefined;
  const pluginName = segments ? (segments[1] ?? pkg) : pkg;
  const strippedName = pluginName.replace(/^opentabs-plugin-/, '');

  let installedPlugin: { name: string; displayName: string; version: string; toolCount: number } | undefined;
  for (const p of state.registry.plugins.values()) {
    if (p.npmPackageName === pkg || p.name === strippedName || p.name === pluginName) {
      installedPlugin = {
        name: p.name,
        displayName: p.displayName,
        version: p.version,
        toolCount: p.tools.length,
      };
      break;
    }
  }

  if (!installedPlugin) {
    const error = new Error(
      `Package "${pkg}" was installed but is not a valid opentabs plugin (no opentabs field in package.json or missing dist/tools.json)`,
    ) as Error & { code: number };
    error.code = -32603;
    throw error;
  }

  return { ok: true, plugin: installedPlugin };
};

export type { PluginSearchResult, PluginInstallResult };
export { normalizePluginName, isValidPluginPackageName, searchNpmPlugins, installPlugin };
