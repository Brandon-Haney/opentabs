import { buildRegistry, emptyRegistry, getPlugin, getTool, listEnabledTools } from './registry.js';
import { describe, expect, test } from 'bun:test';
import type { FailedPlugin, RegisteredPlugin, ServerState } from './state.js';

/**
 * Unit tests for the immutable PluginRegistry module.
 *
 * Tests cover registry construction, tool lookup, plugin retrieval,
 * immutability guarantees, and tool filtering by config.
 */

/** Create a minimal RegisteredPlugin for testing */
const makePlugin = (overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin => ({
  name: 'test',
  version: '1.0.0',
  displayName: 'Test Plugin',
  urlPatterns: ['http://localhost/*'],
  trustTier: 'local',
  source: 'local' as const,
  iife: '(function(){})()',
  tools: [
    {
      name: 'my_tool',
      displayName: 'My Tool',
      description: 'A tool',
      icon: 'wrench',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      output_schema: {},
    },
  ],
  sourcePath: '/tmp/test-plugin',
  adapterHash: 'abc123',
  npmPackageName: 'opentabs-plugin-test',
  ...overrides,
});

/** Create a minimal ServerState for listEnabledTools tests */
const makeState = (toolConfig: Record<string, boolean> = {}): ServerState => ({ toolConfig }) as unknown as ServerState;

describe('buildRegistry', () => {
  test('builds a registry from loaded plugins', () => {
    const plugin = makePlugin();
    const registry = buildRegistry([plugin], []);

    expect(registry.plugins.size).toBe(1);
    expect(registry.plugins.get('test')).toBe(plugin);
    expect(registry.toolLookup.size).toBe(1);
    expect(registry.failures).toHaveLength(0);
  });

  test('builds tool lookup with prefixed names', () => {
    const plugin = makePlugin();
    const registry = buildRegistry([plugin], []);

    const lookup = registry.toolLookup.get('test_my_tool');
    expect(lookup).toBeDefined();
    expect(lookup?.pluginName).toBe('test');
    expect(lookup?.toolName).toBe('my_tool');
  });

  test('compiles Ajv validators for tool input schemas', () => {
    const plugin = makePlugin();
    const registry = buildRegistry([plugin], []);

    const lookup = registry.toolLookup.get('test_my_tool');
    expect(lookup?.validate).toBeTypeOf('function');
    // Valid input should pass
    expect(lookup?.validate?.({ msg: 'hello' })).toBe(true);
  });

  test('handles multiple plugins without name collisions', () => {
    const pluginA = makePlugin({
      name: 'alpha',
      tools: [
        {
          name: 'do_thing',
          displayName: 'Do Thing',
          description: 'Does a thing',
          icon: 'star',
          input_schema: {},
          output_schema: {},
        },
      ],
    });
    const pluginB = makePlugin({
      name: 'beta',
      tools: [
        {
          name: 'do_thing',
          displayName: 'Do Thing',
          description: 'Does a thing',
          icon: 'star',
          input_schema: {},
          output_schema: {},
        },
      ],
    });
    const registry = buildRegistry([pluginA, pluginB], []);

    expect(registry.plugins.size).toBe(2);
    expect(registry.toolLookup.size).toBe(2);
    expect(registry.toolLookup.has('alpha_do_thing')).toBe(true);
    expect(registry.toolLookup.has('beta_do_thing')).toBe(true);
  });

  test('preserves failures in the registry', () => {
    const failures: FailedPlugin[] = [
      { path: '/bad/plugin', error: 'Missing package.json' },
      { path: '/other/plugin', error: 'Invalid opentabs field' },
    ];
    const registry = buildRegistry([], failures);

    expect(registry.failures).toHaveLength(2);
    expect(registry.failures[0]?.path).toBe('/bad/plugin');
    expect(registry.failures[1]?.error).toBe('Invalid opentabs field');
  });

  test('returns frozen registry object', () => {
    const registry = buildRegistry([makePlugin()], []);

    expect(Object.isFrozen(registry)).toBe(true);
  });

  test('handles tool with invalid schema gracefully (validate is null)', () => {
    const plugin = makePlugin({
      tools: [
        {
          name: 'bad_schema',
          displayName: 'Bad',
          description: 'Bad schema',
          icon: 'x',
          input_schema: { type: 'invalid-type-value' } as Record<string, unknown>,
          output_schema: {},
        },
      ],
    });
    const registry = buildRegistry([plugin], []);

    const lookup = registry.toolLookup.get('test_bad_schema');
    expect(lookup).toBeDefined();
    expect(lookup?.validate).toBeNull();
    expect(lookup?.validationErrors()).toContain('Schema compilation failed');
  });
});

describe('emptyRegistry', () => {
  test('returns a registry with no plugins, tools, or failures', () => {
    const registry = emptyRegistry();

    expect(registry.plugins.size).toBe(0);
    expect(registry.toolLookup.size).toBe(0);
    expect(registry.failures).toHaveLength(0);
  });

  test('returns a frozen registry', () => {
    const registry = emptyRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
  });
});

describe('getPlugin', () => {
  test('returns plugin by internal name', () => {
    const plugin = makePlugin({ name: 'slack' });
    const registry = buildRegistry([plugin], []);

    expect(getPlugin(registry, 'slack')).toBe(plugin);
  });

  test('returns undefined for unknown plugin name', () => {
    const registry = buildRegistry([makePlugin()], []);

    expect(getPlugin(registry, 'nonexistent')).toBeUndefined();
  });
});

describe('getTool', () => {
  test('returns plugin, tool, and lookup for a valid prefixed name', () => {
    const plugin = makePlugin();
    const registry = buildRegistry([plugin], []);

    const result = getTool(registry, 'test_my_tool');
    expect(result).toBeDefined();
    expect(result?.plugin).toBe(plugin);
    expect(result?.tool.name).toBe('my_tool');
    expect(result?.lookup.pluginName).toBe('test');
    expect(result?.lookup.toolName).toBe('my_tool');
  });

  test('returns undefined for unknown tool name', () => {
    const registry = buildRegistry([makePlugin()], []);

    expect(getTool(registry, 'test_nonexistent')).toBeUndefined();
  });

  test('returns undefined for empty registry', () => {
    const registry = emptyRegistry();

    expect(getTool(registry, 'anything')).toBeUndefined();
  });
});

describe('listEnabledTools', () => {
  test('returns all tools when none are disabled', () => {
    const plugin = makePlugin();
    const registry = buildRegistry([plugin], []);
    const state = makeState();

    const tools = listEnabledTools(registry, state);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('test_my_tool');
  });

  test('filters out disabled tools', () => {
    const plugin = makePlugin();
    const registry = buildRegistry([plugin], []);
    const state = makeState({ test_my_tool: false });

    const tools = listEnabledTools(registry, state);
    expect(tools).toHaveLength(0);
  });

  test('prefixes description with trust tier for official plugins', () => {
    const plugin = makePlugin({ trustTier: 'official' });
    const registry = buildRegistry([plugin], []);
    const state = makeState();

    const tools = listEnabledTools(registry, state);
    expect(tools[0]?.description).toStartWith('[Official] ');
  });

  test('prefixes description with trust tier for community plugins', () => {
    const plugin = makePlugin({ trustTier: 'community' });
    const registry = buildRegistry([plugin], []);
    const state = makeState();

    const tools = listEnabledTools(registry, state);
    expect(tools[0]?.description).toStartWith('[Community plugin — unverified] ');
  });

  test('prefixes description with trust tier for local plugins', () => {
    const plugin = makePlugin({ trustTier: 'local' });
    const registry = buildRegistry([plugin], []);
    const state = makeState();

    const tools = listEnabledTools(registry, state);
    expect(tools[0]?.description).toStartWith('[Local plugin] ');
  });

  test('returns tools from multiple plugins', () => {
    const pluginA = makePlugin({ name: 'alpha' });
    const pluginB = makePlugin({
      name: 'beta',
      tools: [
        {
          name: 'tool_b',
          displayName: 'Tool B',
          description: 'B tool',
          icon: 'star',
          input_schema: {},
          output_schema: {},
        },
      ],
    });
    const registry = buildRegistry([pluginA, pluginB], []);
    const state = makeState();

    const tools = listEnabledTools(registry, state);
    expect(tools).toHaveLength(2);
    const names = tools.map(t => t.name);
    expect(names).toContain('alpha_my_tool');
    expect(names).toContain('beta_tool_b');
  });

  test('includes inputSchema from tool definitions', () => {
    const plugin = makePlugin();
    const registry = buildRegistry([plugin], []);
    const state = makeState();

    const tools = listEnabledTools(registry, state);
    expect(tools[0]?.inputSchema).toEqual({ type: 'object', properties: { msg: { type: 'string' } } });
  });

  test('returns empty array for empty registry', () => {
    const registry = emptyRegistry();
    const state = makeState();

    const tools = listEnabledTools(registry, state);
    expect(tools).toHaveLength(0);
  });
});
