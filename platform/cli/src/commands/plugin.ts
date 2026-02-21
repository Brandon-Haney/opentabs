/**
 * `opentabs plugin` command — manage plugins (list, add, remove, create).
 */

import { atomicWriteConfig, getConfigPath, getPluginsFromConfig, readConfig, resolvePluginPath } from '../config.js';
import { scaffoldPlugin, ScaffoldError } from '../scaffold.js';
import pc from 'picocolors';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Command } from 'commander';

// --- Subcommand handlers ---

interface PluginListOptions {
  json?: boolean;
}

interface ManifestInfo {
  name: string;
  version: string;
  toolCount: number;
}

const readManifest = async (resolvedPath: string): Promise<ManifestInfo | null> => {
  const pkgJsonPath = join(resolvedPath, 'package.json');
  const toolsJsonPath = join(resolvedPath, 'dist', 'tools.json');
  if (!existsSync(pkgJsonPath) || !existsSync(toolsJsonPath)) return null;
  try {
    const pkg: unknown = await Bun.file(pkgJsonPath).json();
    const tools: unknown = await Bun.file(toolsJsonPath).json();
    if (pkg !== null && typeof pkg === 'object' && 'name' in pkg && 'version' in pkg) {
      const d = pkg as { name: string; version: string };
      const toolCount = Array.isArray(tools) ? tools.length : 0;
      return { name: d.name, version: d.version, toolCount };
    }
    return null;
  } catch {
    return null;
  }
};

const handlePluginList = async (options: PluginListOptions): Promise<void> => {
  const configPath = getConfigPath();
  const config = await readConfig(configPath);

  if (!config) {
    console.error(pc.red(`No config found at ${configPath}`));
    console.error('Run opentabs dev to create one automatically.');
    process.exit(1);
  }

  const plugins = getPluginsFromConfig(config);

  if (plugins.length === 0) {
    console.log('No plugins configured.');
    console.log('Add one with: opentabs plugin add <path>');
    return;
  }

  if (options.json) {
    const entries = await Promise.all(
      plugins.map(async pluginPath => {
        const resolvedPath = resolvePluginPath(pluginPath, configPath);
        const exists = existsSync(resolvedPath);
        const manifest = exists ? await readManifest(resolvedPath) : null;
        return {
          path: pluginPath,
          resolvedPath,
          exists,
          hasManifest: manifest !== null,
          name: manifest?.name,
          version: manifest?.version,
          toolCount: manifest?.toolCount,
        };
      }),
    );
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log('Configured plugins:');
  console.log('');
  for (const pluginPath of plugins) {
    const resolvedPath = resolvePluginPath(pluginPath, configPath);
    const exists = existsSync(resolvedPath);
    const manifest = exists ? await readManifest(resolvedPath) : null;

    if (manifest) {
      const indicator = pc.green('+');
      const name = pc.bold(manifest.name);
      const version = pc.dim(`v${manifest.version}`);
      const tools = pc.dim(`${manifest.toolCount} tool${manifest.toolCount === 1 ? '' : 's'}`);
      console.log(`  ${indicator} ${name} ${version}  ${tools}  ${pc.dim(pluginPath)}`);
    } else if (exists) {
      console.log(`  ${pc.yellow('~')} ${pluginPath} ${pc.yellow('(not built)')}`);
    } else {
      console.log(`  ${pc.red('!')} ${pluginPath} ${pc.red('(not found)')}`);
    }
  }
  console.log('');
  console.log(`  ${pc.green('+')} ready   ${pc.yellow('~')} no manifest   ${pc.red('!')} not found`);
};

const handlePluginAdd = async (pathArg: string): Promise<void> => {
  const configPath = getConfigPath();
  const configDir = dirname(configPath);
  const existing = await readConfig(configPath);
  let config: Record<string, unknown>;

  if (existing) {
    config = existing;
  } else {
    mkdirSync(configDir, { recursive: true });
    config = { plugins: [], tools: {}, secret: crypto.randomUUID() };
  }

  if (!Array.isArray(config.plugins)) config.plugins = [];
  const plugins = config.plugins as string[];

  // Resolve the new path to an absolute path (relative paths resolve against CWD)
  const resolvedNew = resolve(pathArg);

  // Normalize to a relative-to-config-dir form for portable storage
  const normalizedNew = relative(configDir, resolvedNew);

  // Check for duplicates by comparing resolved absolute paths
  const isDuplicate = plugins.some(existing => resolvePluginPath(existing, configPath) === resolvedNew);
  if (isDuplicate) {
    console.log('Plugin path already configured.');
    return;
  }

  if (!existsSync(resolvedNew)) {
    console.warn(pc.yellow(`Warning: Path does not exist: ${normalizedNew}`));
  } else {
    if (!existsSync(join(resolvedNew, 'dist', 'tools.json'))) {
      console.warn(pc.yellow('Warning: No dist/tools.json found — run bun run build in the plugin directory.'));
    }
    if (!existsSync(join(resolvedNew, 'dist', 'adapter.iife.js'))) {
      console.warn(pc.yellow('Warning: No dist/adapter.iife.js found — run bun run build in the plugin directory.'));
    }
  }

  plugins.push(normalizedNew);
  await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(pc.green(`Added: ${normalizedNew}`));
  console.log('The MCP server will detect the change automatically.');
};

const handlePluginRemove = async (nameOrPath: string): Promise<void> => {
  const configPath = getConfigPath();
  const config = await readConfig(configPath);

  if (!config) {
    console.error(pc.red(`No config found at ${configPath}`));
    console.error('Run opentabs dev to create one automatically.');
    process.exit(1);
  }

  if (!Array.isArray(config.plugins)) config.plugins = [];
  const plugins = config.plugins as string[];

  const idx = plugins.findIndex(p => p === nameOrPath || p.endsWith('/' + nameOrPath) || p.endsWith('\\' + nameOrPath));

  if (idx === -1) {
    console.error(pc.red('Plugin not found in config.'));
    console.error('Run opentabs plugin list to see configured plugins.');
    process.exit(1);
  }

  const removed = plugins.splice(idx, 1)[0] as string;
  await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(pc.green(`Removed: ${removed}`));
  console.log('The MCP server will detect the change automatically.');
};

// --- Command registration ---

export const registerPluginCommand = (program: Command): void => {
  const pluginCmd = program
    .command('plugin')
    .description('Manage plugins (create, list, add, remove)')
    .action(() => {
      pluginCmd.help();
    });

  pluginCmd
    .command('create')
    .description('Scaffold a new plugin project')
    .argument('<name>', 'Plugin name (lowercase alphanumeric + hyphens)')
    .requiredOption('--domain <domain>', 'Target domain (e.g., .slack.com or github.com)')
    .option('--display <name>', 'Display name (e.g., Slack)')
    .option('--description <desc>', 'Plugin description')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin create my-plugin --domain .example.com
  $ opentabs plugin create slack --domain .slack.com --display Slack`,
    )
    .action(async (name: string, options: { domain: string; display?: string; description?: string }) => {
      try {
        await scaffoldPlugin({
          name,
          domain: options.domain,
          display: options.display,
          description: options.description,
        });
      } catch (err: unknown) {
        if (err instanceof ScaffoldError) {
          console.error(pc.red(`Error: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });

  pluginCmd
    .command('list')
    .description('List configured plugins and their status')
    .option('--json', 'Output plugin info as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin list
  $ opentabs plugin list --json`,
    )
    .action((options: PluginListOptions) => handlePluginList(options));

  pluginCmd
    .command('add')
    .description('Add a plugin path to the config')
    .argument('<path>', 'Path to the plugin directory')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin add ./my-plugin
  $ opentabs plugin add /absolute/path/to/plugin`,
    )
    .action((pathArg: string) => handlePluginAdd(pathArg));

  pluginCmd
    .command('remove')
    .description('Remove a plugin path from the config')
    .argument('<path-or-name>', 'Exact path or plugin directory name to match')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs plugin remove ./my-plugin
  $ opentabs plugin remove my-plugin`,
    )
    .action((nameOrPath: string) => handlePluginRemove(nameOrPath));
};
