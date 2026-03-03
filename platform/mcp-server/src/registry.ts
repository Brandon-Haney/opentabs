/**
 * Immutable plugin registry.
 *
 * Holds all discovered plugins, a pre-built O(1) tool lookup map with
 * compiled Ajv validators, and a list of discovery failures. The registry
 * is built once and never mutated — when plugins change, a new registry
 * is constructed and swapped atomically on ServerState.
 */

import { log } from './logger.js';
import { prefixedToolName, freezeRegistryMap } from './state.js';
import AjvValidator from 'ajv';
import type { FailedPlugin, PluginRegistry, RegisteredPlugin, ToolLookupEntry } from './state.js';
import type { ManifestTool, TrustTier } from '@opentabs-dev/shared';

/** Result of looking up a tool in the registry */
interface ToolLookupResult {
  readonly plugin: RegisteredPlugin;
  readonly tool: ManifestTool;
  readonly lookup: ToolLookupEntry;
}

/** Map trust tier to a human-readable prefix for MCP tool descriptions */
const trustTierPrefix = (tier: TrustTier): string => {
  switch (tier) {
    case 'official':
      return '[Official] ';
    case 'community':
      return '[Community plugin — unverified] ';
    case 'local':
      return '[Local plugin] ';
  }
};

/**
 * Compile a JSON Schema into an Ajv validate function.
 * Returns a ToolLookupEntry with the validate fn and error formatter.
 * If compilation fails, validate is null and errors are logged.
 */
const compileToolValidator = (
  ajv: InstanceType<typeof AjvValidator>,
  pluginName: string,
  toolName: string,
  inputSchema: Record<string, unknown>,
): Pick<ToolLookupEntry, 'validate' | 'validationErrors'> => {
  try {
    const validate = ajv.compile(inputSchema);
    return {
      validate,
      validationErrors: () => {
        if (!validate.errors?.length) return 'Unknown validation error';
        return validate.errors
          .map(e => {
            const path = e.instancePath || '(root)';
            return `  - ${path}: ${e.message ?? 'invalid'}`;
          })
          .join('\n');
      },
    };
  } catch (err) {
    log.warn(`Failed to compile JSON Schema for ${pluginName}/${toolName}:`, err);
    return {
      validate: null,
      validationErrors: () => 'Schema compilation failed — validation skipped',
    };
  }
};

/**
 * Build an immutable PluginRegistry from loaded plugins and failures.
 *
 * Compiles Ajv validators for each tool's input schema during construction
 * so that tool dispatch has O(1) lookup with pre-compiled validation.
 *
 * All returned objects are frozen to prevent accidental mutation.
 */
const buildRegistry = (
  loadedPlugins: readonly RegisteredPlugin[],
  failures: readonly FailedPlugin[],
): PluginRegistry => {
  const ajv = new AjvValidator({ allErrors: false });
  const plugins = new Map<string, RegisteredPlugin>();
  const toolLookup = new Map<string, ToolLookupEntry>();

  for (const plugin of loadedPlugins) {
    plugins.set(plugin.name, plugin);
    for (const toolDef of plugin.tools) {
      const prefixed = prefixedToolName(plugin.name, toolDef.name);
      const { validate, validationErrors } = compileToolValidator(ajv, plugin.name, toolDef.name, toolDef.input_schema);
      toolLookup.set(prefixed, { pluginName: plugin.name, toolName: toolDef.name, validate, validationErrors });
    }
  }

  const registry: PluginRegistry = {
    plugins: freezeRegistryMap(plugins),
    toolLookup: freezeRegistryMap(toolLookup),
    failures,
  };

  return Object.freeze(registry);
};

/** Create an empty registry (used for initial state) */
const emptyRegistry = (): PluginRegistry => buildRegistry([], []);

/** Get a plugin by internal name, or undefined if not found */
const getPlugin = (registry: PluginRegistry, name: string): RegisteredPlugin | undefined => registry.plugins.get(name);

/** Get a tool by prefixed name, or undefined if not found */
const getTool = (registry: PluginRegistry, prefixedName: string): ToolLookupResult | undefined => {
  const lookup = registry.toolLookup.get(prefixedName);
  if (!lookup) return undefined;

  const plugin = registry.plugins.get(lookup.pluginName);
  if (!plugin) return undefined;

  const tool = plugin.tools.find(t => t.name === lookup.toolName);
  if (!tool) return undefined;

  return { plugin, tool, lookup };
};

export { buildRegistry, emptyRegistry, getPlugin, getTool, trustTierPrefix };
export type { ToolLookupResult };
