/**
 * `opentabs plugin` command — plugin management (create, search, install, remove, list).
 */

import { colorTabState } from './status.js';
import {
  atomicWriteConfig,
  getConfigPath,
  getLocalPluginsFromConfig,
  isConnectionRefused,
  readConfig,
  resolvePluginPath,
} from '../config.js';
import { parsePort, resolvePort } from '../parse-port.js';
import { scaffoldPlugin, promptForMissingArgs, ScaffoldError } from '../scaffold.js';
import { TOOLS_FILENAME, platformExec } from '@opentabs-dev/shared';
import pc from 'picocolors';
import { join } from 'node:path';
import type { Command } from 'commander';

// --- npm registry types ---

interface NpmSearchPackage {
  name: string;
  description?: string;
  version: string;
  publisher?: { username: string };
}

interface NpmSearchResult {
  objects: Array<{ package: NpmSearchPackage }>;
}

// --- Helpers ---

/**
 * Normalize a shorthand plugin name to its full npm package name.
 * "slack" → "opentabs-plugin-slack", but scoped names and full names pass through.
 */
const normalizePluginName = (name: string): string => {
  if (name.startsWith('@') || name.startsWith('opentabs-plugin-')) return name;
  return `opentabs-plugin-${name}`;
};

/**
 * Notify the running MCP server to rediscover plugins via POST /reload.
 * Non-fatal — prints a hint on failure but never throws.
 */
const notifyServer = async (options: { port?: number }): Promise<void> => {
  const port = resolvePort(options);
  const configPath = getConfigPath();
  const { config } = await readConfig(configPath);
  const secret = config && typeof config.secret === 'string' ? config.secret : null;

  try {
    const healthRes = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!healthRes.ok) return;
  } catch {
    // Server not running — nothing to notify
    return;
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const res = await fetch(`http://localhost:${port}/reload`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    if (res.ok) {
      console.log(pc.dim('Server notified — plugins rediscovered.'));
    } else {
      console.log(pc.dim(`Could not notify server (HTTP ${res.status}). Restart the server to pick up changes.`));
    }
  } catch {
    console.log(pc.dim('Could not notify server. Restart the server to pick up changes.'));
  }
};

// --- Install handler ---

const handlePluginInstall = async (name: string, options: { port?: number }): Promise<void> => {
  const pkg = normalizePluginName(name);
  console.log(`Installing ${pc.bold(pkg)}...`);

  const proc = Bun.spawn([platformExec('npm'), 'install', '-g', pkg], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(pc.red(`npm install failed (exit code ${exitCode}).`));
    process.exit(1);
  }

  console.log(pc.green(`Successfully installed ${pkg}.`));
  await notifyServer(options);
};

// --- Remove handler ---

/**
 * Remove matching entries from localPlugins in config.
 * An entry matches if its resolved package.json `name` field equals the package name.
 */
const removeFromLocalPlugins = async (pkg: string): Promise<void> => {
  const configPath = getConfigPath();
  const { config } = await readConfig(configPath);
  if (!config) return;

  const localPlugins = getLocalPluginsFromConfig(config);
  if (localPlugins.length === 0) return;

  const remaining: string[] = [];
  for (const entry of localPlugins) {
    const resolved = resolvePluginPath(entry, configPath);
    const pkgJsonPath = join(resolved, 'package.json');
    try {
      const pkgJson: unknown = JSON.parse(await Bun.file(pkgJsonPath).text());
      if (typeof pkgJson === 'object' && pkgJson !== null && (pkgJson as Record<string, unknown>).name === pkg) {
        continue;
      }
    } catch {
      // Cannot read package.json — keep the entry
    }
    remaining.push(entry);
  }

  if (remaining.length < localPlugins.length) {
    const removed = localPlugins.length - remaining.length;
    config.localPlugins = remaining;
    await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(
      pc.dim(`Removed ${removed.toString()} local plugin ${removed === 1 ? 'entry' : 'entries'} from config.`),
    );
  }
};

const handlePluginRemove = async (name: string, options: { port?: number }): Promise<void> => {
  const pkg = normalizePluginName(name);
  console.log(`Removing ${pc.bold(pkg)}...`);

  const proc = Bun.spawn([platformExec('npm'), 'uninstall', '-g', pkg], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(pc.red(`npm uninstall failed (exit code ${exitCode}).`));
    process.exit(1);
  }

  console.log(pc.green(`Successfully removed ${pkg}.`));
  await removeFromLocalPlugins(pkg);
  await notifyServer(options);
};

// --- Search handler ---

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';

const handlePluginSearch = async (query?: string): Promise<void> => {
  const params = new URLSearchParams({
    text: query ? `keywords:opentabs-plugin ${query}` : 'keywords:opentabs-plugin',
    size: '20',
  });

  let data: NpmSearchResult;
  try {
    const response = await fetch(`${NPM_SEARCH_URL}?${params.toString()}`);

    if (response.status === 429) {
      console.error(pc.yellow('npm registry rate limit reached. Try again in a moment.'));
      process.exit(1);
    }
    if (!response.ok) {
      console.error(pc.red(`npm registry returned an error (HTTP ${response.status.toString()}). Try again later.`));
      process.exit(1);
    }

    data = (await response.json()) as NpmSearchResult;
  } catch {
    console.error(pc.red('Could not reach npm registry. Check your internet connection.'));
    process.exit(1);
  }

  if (data.objects.length === 0) {
    const term = query ?? '';
    console.log(pc.yellow(`No plugins found for '${term}'. Try a different search term.`));
    return;
  }

  console.log();
  for (const { package: pkg } of data.objects) {
    const label = pkg.name.startsWith('@opentabs-dev/') ? pc.blue('[official]') : pc.dim('[community]');
    const desc = pkg.description
      ? pkg.description.length > 60
        ? pkg.description.slice(0, 57) + '...'
        : pkg.description
      : '';
    const author = pkg.publisher?.username ?? 'unknown';

    console.log(`  ${label} ${pc.bold(pkg.name)} ${pc.dim(`v${pkg.version}`)} — ${desc} ${pc.dim(`by ${author}`)}`);
  }
  console.log();
  console.log(`Install a plugin: ${pc.cyan('opentabs plugin install <name>')}`);
  console.log();
};

// --- List handler ---

interface PluginListOptions {
  port?: number;
  json?: boolean;
}

interface HealthPluginDetail {
  name: string;
  displayName: string;
  toolCount: number;
  tabState: string;
  source?: string;
  sdkVersion?: string | null;
}

interface HealthFailedPlugin {
  specifier: string;
  error: string;
}

interface ListPluginEntry {
  name: string;
  displayName: string;
  version: string | null;
  source: 'npm' | 'local';
  tabState: string | null;
  toolCount: number;
}

/**
 * Read basic info from a local plugin directory (package.json + dist/tools.json).
 */
const readLocalPluginInfo = async (
  pluginDir: string,
): Promise<{ name: string; displayName: string; version: string | null; toolCount: number } | null> => {
  try {
    const pkgJsonText = await Bun.file(join(pluginDir, 'package.json')).text();
    const pkgJson = JSON.parse(pkgJsonText) as Record<string, unknown>;
    const name = typeof pkgJson.name === 'string' ? pkgJson.name : null;
    if (!name) return null;

    const opentabs = typeof pkgJson.opentabs === 'object' && pkgJson.opentabs !== null ? pkgJson.opentabs : null;
    const displayName =
      opentabs && typeof (opentabs as Record<string, unknown>).displayName === 'string'
        ? ((opentabs as Record<string, unknown>).displayName as string)
        : name;
    const version = typeof pkgJson.version === 'string' ? pkgJson.version : null;

    let toolCount = 0;
    try {
      const toolsJsonText = await Bun.file(join(pluginDir, 'dist', TOOLS_FILENAME)).text();
      const toolsJson = JSON.parse(toolsJsonText) as Record<string, unknown>;
      const tools = Array.isArray(toolsJson.tools) ? toolsJson.tools : [];
      toolCount = tools.length;
    } catch {
      // dist/tools.json may not exist (plugin not built yet)
    }

    return { name, displayName, version, toolCount };
  } catch {
    return null;
  }
};

/**
 * Scan global node_modules for npm-installed opentabs plugins using `npm list -g --json`.
 */
const scanNpmPlugins = async (): Promise<ListPluginEntry[]> => {
  const entries: ListPluginEntry[] = [];
  try {
    const proc = Bun.spawn([platformExec('npm'), 'list', '-g', '--json', '--depth=0'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const data = JSON.parse(stdout) as Record<string, unknown>;
    const deps = typeof data.dependencies === 'object' && data.dependencies !== null ? data.dependencies : {};

    for (const [pkgName, info] of Object.entries(deps as Record<string, Record<string, unknown>>)) {
      const isPlugin = pkgName.startsWith('opentabs-plugin-') || /^@[^/]+\/opentabs-plugin-/.test(pkgName);
      if (!isPlugin) continue;

      const version = typeof info.version === 'string' ? info.version : null;
      entries.push({
        name: pkgName,
        displayName: pkgName,
        version,
        source: 'npm',
        tabState: null,
        toolCount: 0,
      });
    }
  } catch {
    // npm not available or no global packages
  }
  return entries;
};

const handlePluginList = async (options: PluginListOptions): Promise<void> => {
  const port = resolvePort(options);

  // Try to fetch from running server first
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const pluginDetails = Array.isArray(data.pluginDetails) ? (data.pluginDetails as HealthPluginDetail[]) : [];
      const failedPlugins = Array.isArray(data.failedPlugins) ? (data.failedPlugins as HealthFailedPlugin[]) : [];

      if (options.json) {
        console.log(JSON.stringify({ plugins: pluginDetails, failedPlugins }, null, 2));
        return;
      }

      if (pluginDetails.length === 0 && failedPlugins.length === 0) {
        console.log(pc.dim('No plugins installed.'));
        console.log(`\nSearch for plugins: ${pc.cyan('opentabs plugin search')}`);
        return;
      }

      console.log(pc.bold('Installed Plugins'));
      console.log();

      for (const p of pluginDetails) {
        const state = colorTabState(p.tabState);
        const tools = pc.dim(`${p.toolCount} tool${p.toolCount === 1 ? '' : 's'}`);
        const sourceLabel = p.source === 'local' ? pc.dim('(local)') : pc.dim('(npm)');
        const sdkWarning = p.sdkVersion === null ? ` ${pc.yellow('⚠ no SDK version')}` : '';
        console.log(`  ${p.displayName} ${sourceLabel} ${pc.dim('—')} ${state} ${pc.dim('·')} ${tools}${sdkWarning}`);
      }

      if (failedPlugins.length > 0) {
        console.log();
        console.log(pc.bold('Failed Plugins'));
        console.log();
        for (const f of failedPlugins) {
          console.log(`  ${pc.red(f.specifier)} ${pc.dim('—')} ${f.error}`);
        }
      }

      return;
    }
  } catch (err: unknown) {
    if (!isConnectionRefused(err)) {
      // Unexpected error (not just "server not running") — still fall through to offline mode
    }
  }

  // Offline mode — server is not running
  const configPath = getConfigPath();
  const { config } = await readConfig(configPath);
  const localPlugins = config ? getLocalPluginsFromConfig(config) : [];

  const localEntries: ListPluginEntry[] = [];
  for (const entry of localPlugins) {
    const resolved = resolvePluginPath(entry, configPath);
    const info = await readLocalPluginInfo(resolved);
    if (info) {
      localEntries.push({
        name: info.name,
        displayName: info.displayName,
        version: info.version,
        source: 'local',
        tabState: null,
        toolCount: info.toolCount,
      });
    } else {
      localEntries.push({
        name: entry,
        displayName: entry,
        version: null,
        source: 'local',
        tabState: null,
        toolCount: 0,
      });
    }
  }

  const npmEntries = await scanNpmPlugins();

  // Deduplicate: local entries take precedence over npm entries with the same name
  const seenNames = new Set(localEntries.map(e => e.name));
  const deduped = [...localEntries, ...npmEntries.filter(e => !seenNames.has(e.name))];

  if (options.json) {
    console.log(JSON.stringify({ plugins: deduped, serverRunning: false }, null, 2));
    return;
  }

  if (deduped.length === 0) {
    console.log(pc.dim('No plugins installed.'));
    console.log(`\nSearch for plugins: ${pc.cyan('opentabs plugin search')}`);
    return;
  }

  console.log(pc.bold('Installed Plugins'));
  console.log(pc.dim('(server not running — tab state unavailable)'));
  console.log();

  for (const p of deduped) {
    const version = p.version ? pc.dim(`v${p.version}`) : pc.dim('unknown version');
    const sourceLabel = p.source === 'local' ? pc.dim('(local)') : pc.dim('(npm)');
    const tools = p.toolCount > 0 ? pc.dim(`${p.toolCount} tool${p.toolCount === 1 ? '' : 's'}`) : '';
    const parts = [p.displayName, sourceLabel, pc.dim('—'), version];
    if (tools) parts.push(pc.dim('·'), tools);
    console.log(`  ${parts.join(' ')}`);
  }
};

// --- Command registration ---

const registerPluginCommand = (program: Command): void => {
  const pluginCmd = program
    .command('plugin')
    .description('Manage plugins')
    .action(() => {
      pluginCmd.help();
    });

  pluginCmd
    .command('search')
    .description('Search npm registry for opentabs plugins')
    .argument('[query]', 'Search term (optional — lists all plugins if omitted)')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin search slack
  $ opentabs plugin search          # lists all available plugins`,
    )
    .action(async (query?: string) => {
      await handlePluginSearch(query);
    });

  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option('--port <number>', 'Server port (default: 9515)', parsePort)
    .option('--json', 'Output machine-readable JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin list
  $ opentabs plugin list --json
  $ opentabs plugin list --port 3000`,
    )
    .action((_options: PluginListOptions, command: Command) => handlePluginList(command.optsWithGlobals()));

  pluginCmd
    .command('install')
    .description('Install a plugin from npm')
    .argument('<name>', 'Plugin name or full package name (e.g., slack or opentabs-plugin-slack)')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin install slack
  $ opentabs plugin install opentabs-plugin-slack
  $ opentabs plugin install @my-org/opentabs-plugin-custom`,
    )
    .action((name: string, _options: unknown, command: Command) =>
      handlePluginInstall(name, command.optsWithGlobals()),
    );

  pluginCmd
    .command('remove')
    .description('Remove a globally installed plugin')
    .argument('<name>', 'Plugin name or full package name (e.g., slack or opentabs-plugin-slack)')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin remove slack
  $ opentabs plugin remove opentabs-plugin-slack
  $ opentabs plugin remove @my-org/opentabs-plugin-custom`,
    )
    .action((name: string, _options: unknown, command: Command) => handlePluginRemove(name, command.optsWithGlobals()));

  pluginCmd
    .command('create')
    .description('Scaffold a new plugin project')
    .argument('[name]', 'Plugin name (lowercase alphanumeric + hyphens)')
    .option('--domain <domain>', 'Target domain (e.g., .slack.com or github.com)')
    .option('--display <name>', 'Display name (e.g., Slack)')
    .option('--description <desc>', 'Plugin description')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin create                                  # interactive mode
  $ opentabs plugin create my-plugin --domain .example.com
  $ opentabs plugin create slack --domain .slack.com --display Slack`,
    )
    .action(async (name: string | undefined, options: { domain?: string; display?: string; description?: string }) => {
      try {
        const args = await promptForMissingArgs({
          name,
          domain: options.domain,
          display: options.display,
          description: options.description,
        });
        await scaffoldPlugin(args);
      } catch (err: unknown) {
        if (err instanceof ScaffoldError) {
          console.error(pc.red(`Error: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });
};

export { registerPluginCommand };
