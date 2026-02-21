/**
 * `opentabs config` command — view and manage configuration.
 */

import { atomicWriteConfig, getConfigPath, readConfig } from '../config.js';
import { resolvePort } from '../parse-port.js';
import pc from 'picocolors';
import { resolve } from 'node:path';
import type { Command } from 'commander';

const REDACTED = '***';

const redactSecret = (config: Record<string, unknown>): Record<string, unknown> => {
  if (typeof config.secret === 'string') {
    return { ...config, secret: REDACTED };
  }
  return config;
};

const handleConfigPath = (): void => {
  console.log(getConfigPath());
};

interface ConfigShowOptions {
  json?: boolean;
}

const handleConfigShow = async (options: ConfigShowOptions): Promise<void> => {
  const configPath = getConfigPath();
  const result = await readConfig(configPath);

  if (!result.config) {
    if (result.error === 'invalid') {
      console.error(pc.red(`Invalid config at ${configPath}: ${result.message}`));
    } else {
      console.error(pc.red(`No config found at ${configPath}`));
    }
    console.error('Run opentabs start to auto-create config.');
    process.exit(1);
  }

  const config = result.config;

  const redacted = redactSecret(config);

  if (options.json) {
    console.log(JSON.stringify(redacted, null, 2));
  } else {
    console.log(pc.bold('OpenTabs Config'));
    console.log(pc.dim(configPath));
    console.log('');

    for (const [key, value] of Object.entries(redacted)) {
      if (key === 'localPlugins' && Array.isArray(value)) {
        console.log(`  ${pc.cyan('localPlugins')}`);
        if (value.length === 0) {
          console.log(`    ${pc.dim('(none)')}`);
        } else {
          for (const p of value) {
            console.log(`    - ${String(p)}`);
          }
        }
      } else if (key === 'tools' && typeof value === 'object' && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>);
        console.log(`  ${pc.cyan('tools')}`);
        if (entries.length === 0) {
          console.log(`    ${pc.dim('(none)')}`);
        } else {
          for (const [toolName, enabled] of entries) {
            const indicator = enabled ? pc.green('enabled') : pc.red('disabled');
            console.log(`    ${toolName}: ${indicator}`);
          }
        }
      } else {
        const display =
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value);
        console.log(`  ${pc.cyan(key)}  ${display}`);
      }
    }
  }
};

const TOOL_PREFIX = 'tool.';
const LOCAL_PLUGINS_ADD = 'localPlugins.add';
const LOCAL_PLUGINS_REMOVE = 'localPlugins.remove';
const PORT_KEY = 'port';

const SUPPORTED_KEYS = `Supported keys:
  tool.<plugin>_<tool>    Enable/disable a tool (value: enabled | disabled)
  port                    Set the server port (value: 1-65535)
  localPlugins.add        Add a local plugin path (value: absolute or relative path)
  localPlugins.remove     Remove a local plugin path (value: path to remove)`;

const loadConfig = async (): Promise<{ config: Record<string, unknown>; configPath: string }> => {
  const configPath = getConfigPath();
  const result = await readConfig(configPath);
  if (!result.config) {
    if (result.error === 'invalid') {
      console.error(pc.red(`Invalid config at ${configPath}: ${result.message}`));
    } else {
      console.error(pc.red(`No config found at ${configPath}`));
    }
    console.error('Run opentabs start to auto-create config.');
    process.exit(1);
  }
  return { config: result.config, configPath };
};

interface HealthPluginDetail {
  name: string;
  displayName: string;
  tools: string[];
}

const fetchToolNames = async (port: number): Promise<string[] | null> => {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pluginDetails?: HealthPluginDetail[] };
    if (!Array.isArray(data.pluginDetails)) return null;
    return data.pluginDetails.flatMap(p => p.tools);
  } catch {
    return null;
  }
};

const handleListTools = async (): Promise<void> => {
  const port = resolvePort({});
  const tools = await fetchToolNames(port);

  if (!tools) {
    console.error(pc.yellow('Cannot reach the MCP server to list available tools.'));
    console.error(`Start it with: ${pc.bold('opentabs start')}`);
    console.error('');
    console.error('Tool names use the format <plugin>_<tool>, e.g. slack_send_message');
    process.exit(1);
  }

  if (tools.length === 0) {
    console.log(pc.dim('No tools available (no plugins installed).'));
    return;
  }

  console.log(pc.bold('Available tools:'));
  for (const name of tools) {
    console.log(`  ${name}`);
  }
  console.log('');
  console.log(pc.dim('Usage: opentabs config set tool.<name> enabled|disabled'));
};

const handleSetTool = async (key: string, value: string): Promise<void> => {
  const toolName = key.slice(TOOL_PREFIX.length);
  if (!toolName || !toolName.includes('_')) {
    console.error(pc.red(`Invalid tool name: ${toolName || '(empty)'}`));
    console.error('Tool names use the format <plugin>_<tool>, e.g. slack_send_message');
    console.error(`Run ${pc.bold('opentabs config set tool.')} to list available tools.`);
    process.exit(1);
  }

  if (value !== 'enabled' && value !== 'disabled') {
    console.error(pc.red(`Invalid value: ${value}`));
    console.error('Value must be "enabled" or "disabled".');
    process.exit(1);
  }

  const { config, configPath } = await loadConfig();

  if (!config.tools || typeof config.tools !== 'object' || Array.isArray(config.tools)) {
    config.tools = {};
  }
  const tools = config.tools as Record<string, boolean>;
  const enabled = value === 'enabled';
  tools[toolName] = enabled;

  await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');

  const indicator = enabled ? pc.green('enabled') : pc.red('disabled');
  console.log(`${toolName}: ${indicator}`);
};

const handleSetPort = async (value: string): Promise<void> => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(pc.red(`Invalid port: ${value}`));
    console.error('Port must be an integer between 1 and 65535.');
    process.exit(1);
  }

  const { config, configPath } = await loadConfig();
  config.port = port;

  await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`port: ${pc.cyan(String(port))}`);
};

const handleSetLocalPluginsAdd = async (value: string): Promise<void> => {
  const pluginPath = resolve(value);
  const { config, configPath } = await loadConfig();

  if (!Array.isArray(config.localPlugins)) {
    config.localPlugins = [];
  }
  const plugins = config.localPlugins as string[];

  if (plugins.includes(pluginPath)) {
    console.log(`${pc.dim('Already registered:')} ${pluginPath}`);
    return;
  }

  plugins.push(pluginPath);
  await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`${pc.green('Added:')} ${pluginPath}`);
};

const handleSetLocalPluginsRemove = async (value: string): Promise<void> => {
  const pluginPath = resolve(value);
  const { config, configPath } = await loadConfig();

  if (!Array.isArray(config.localPlugins)) {
    console.error(pc.red(`Path not found in localPlugins: ${pluginPath}`));
    process.exit(1);
  }
  const plugins = config.localPlugins as string[];
  const index = plugins.indexOf(pluginPath);

  if (index === -1) {
    console.error(pc.red(`Path not found in localPlugins: ${pluginPath}`));
    process.exit(1);
  }

  plugins.splice(index, 1);
  await atomicWriteConfig(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`${pc.green('Removed:')} ${pluginPath}`);
};

const handleConfigSet = async (key: string, value?: string): Promise<void> => {
  if (key === TOOL_PREFIX) {
    return handleListTools();
  }

  if (!value) {
    console.error(pc.red('Missing value.'));
    console.error(SUPPORTED_KEYS);
    process.exit(1);
  }

  if (key.startsWith(TOOL_PREFIX)) {
    return handleSetTool(key, value);
  }
  if (key === PORT_KEY) {
    return handleSetPort(value);
  }
  if (key === LOCAL_PLUGINS_ADD) {
    return handleSetLocalPluginsAdd(value);
  }
  if (key === LOCAL_PLUGINS_REMOVE) {
    return handleSetLocalPluginsRemove(value);
  }

  console.error(pc.red(`Unknown config key: ${key}`));
  console.error(SUPPORTED_KEYS);
  process.exit(1);
};

interface ConfigResetOptions {
  confirm?: boolean;
}

const handleConfigReset = async (options: ConfigResetOptions): Promise<void> => {
  const configPath = getConfigPath();
  const configFile = Bun.file(configPath);

  if (!(await configFile.exists())) {
    console.log(`No config file found at ${configPath}`);
    return;
  }

  if (!options.confirm) {
    console.error(pc.yellow(`This will delete your config at ${configPath}.`));
    console.error(pc.yellow('Your server secret will change on next start.'));
    console.error('');
    console.error(`Run with ${pc.bold('--confirm')} to proceed:`);
    console.error(`  opentabs config reset --confirm`);
    process.exit(1);
  }

  await configFile.delete();
  console.log('Config reset. Run opentabs start to regenerate.');
};

const registerConfigCommand = (program: Command): void => {
  const configCmd = program
    .command('config')
    .description('View and manage configuration')
    .action(() => {
      configCmd.help();
    });

  configCmd
    .command('set <key> [value]')
    .description('Set a config value')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs config set tool.                              List available tools
  $ opentabs config set tool.slack_send_message disabled
  $ opentabs config set tool.slack_send_message enabled
  $ opentabs config set port 9515
  $ opentabs config set localPlugins.add /path/to/plugin
  $ opentabs config set localPlugins.remove /path/to/plugin`,
    )
    .action((key: string, value?: string) => handleConfigSet(key, value));

  configCmd
    .command('path')
    .description('Print the config file path')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs config path`,
    )
    .action(() => handleConfigPath());

  configCmd
    .command('show')
    .description('Show config contents (secret redacted)')
    .option('--json', 'Output config as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs config show
  $ opentabs config show --json`,
    )
    .action((options: ConfigShowOptions) => handleConfigShow(options));

  configCmd
    .command('reset')
    .description('Delete config file (server will regenerate on next start)')
    .option('--confirm', 'Skip confirmation and delete immediately')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs config reset --confirm`,
    )
    .action((options: ConfigResetOptions) => handleConfigReset(options));
};

export { registerConfigCommand };
