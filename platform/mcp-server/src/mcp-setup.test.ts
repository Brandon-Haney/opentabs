import { rebuildToolLookups, trustTierPrefix } from './mcp-setup.js';
import { createState } from './state.js';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { BrowserToolDefinition } from './browser-tools/definition.js';
import type { RegisteredPlugin } from './state.js';

/** Create a minimal RegisteredPlugin for testing */
const createPlugin = (name: string, toolNames: string[]): RegisteredPlugin => ({
  name,
  version: '1.0.0',
  urlPatterns: [`https://${name}.example.com/*`],
  trustTier: 'local',
  iife: `(function(){/* ${name} */})()`,
  tools: toolNames.map(t => ({
    name: t,
    description: `${t} description`,
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  })),
});

describe('rebuildToolLookups — plugin tool lookup', () => {
  test('populates toolLookup with correct prefixed names', () => {
    const state = createState();
    state.plugins.set('slack', createPlugin('slack', ['send_message', 'read_messages']));

    rebuildToolLookups(state);

    expect(state.toolLookup.size).toBe(2);
    expect(state.toolLookup.get('slack_send_message')).toMatchObject({ pluginName: 'slack', toolName: 'send_message' });
    expect(state.toolLookup.get('slack_read_messages')).toMatchObject({
      pluginName: 'slack',
      toolName: 'read_messages',
    });
  });

  test('empty plugins produces empty toolLookup', () => {
    const state = createState();

    rebuildToolLookups(state);

    expect(state.toolLookup.size).toBe(0);
  });

  test('multiple plugins produces correct entries for all tools', () => {
    const state = createState();
    state.plugins.set('slack', createPlugin('slack', ['send_message']));
    state.plugins.set('github', createPlugin('github', ['create_issue', 'list_prs']));

    rebuildToolLookups(state);

    expect(state.toolLookup.size).toBe(3);
    expect(state.toolLookup.get('slack_send_message')).toMatchObject({ pluginName: 'slack', toolName: 'send_message' });
    expect(state.toolLookup.get('github_create_issue')).toMatchObject({
      pluginName: 'github',
      toolName: 'create_issue',
    });
    expect(state.toolLookup.get('github_list_prs')).toMatchObject({ pluginName: 'github', toolName: 'list_prs' });
  });

  test('replaces previous toolLookup entries on rebuild', () => {
    const state = createState();
    state.plugins.set('slack', createPlugin('slack', ['send_message']));
    rebuildToolLookups(state);
    expect(state.toolLookup.size).toBe(1);

    // Change plugins and rebuild
    state.plugins.clear();
    state.plugins.set('github', createPlugin('github', ['create_issue']));
    rebuildToolLookups(state);

    expect(state.toolLookup.size).toBe(1);
    expect(state.toolLookup.has('slack_send_message')).toBe(false);
    expect(state.toolLookup.get('github_create_issue')).toMatchObject({
      pluginName: 'github',
      toolName: 'create_issue',
    });
  });
});

describe('rebuildToolLookups — cached browser tools', () => {
  test('populates cachedBrowserTools with pre-computed JSON schemas', () => {
    const state = createState();
    const browserTool: BrowserToolDefinition = {
      name: 'browser_list_tabs',
      description: 'List all open tabs',
      input: z.object({}),
      handler: () => Promise.resolve([]),
    };
    state.browserTools = [browserTool];

    rebuildToolLookups(state);

    expect(state.cachedBrowserTools).toHaveLength(1);
    const cachedRaw = state.cachedBrowserTools[0];
    expect(cachedRaw).toBeDefined();
    const cached = cachedRaw as NonNullable<typeof cachedRaw>;
    expect(cached.name).toBe('browser_list_tabs');
    expect(cached.description).toBe('List all open tabs');
    expect(cached.inputSchema).toBeDefined();
    expect(typeof cached.inputSchema).toBe('object');
    expect(cached.tool).toBe(browserTool);
  });

  test('empty browserTools produces empty cachedBrowserTools', () => {
    const state = createState();
    state.browserTools = [];

    rebuildToolLookups(state);

    expect(state.cachedBrowserTools).toHaveLength(0);
  });

  test('multiple browser tools produce correct cached entries', () => {
    const state = createState();
    state.browserTools = [
      {
        name: 'browser_list_tabs',
        description: 'List tabs',
        input: z.object({}),
        handler: () => Promise.resolve([]),
      },
      {
        name: 'browser_open_tab',
        description: 'Open a tab',
        input: z.object({ url: z.string() }),
        handler: () => Promise.resolve({}),
      },
    ];

    rebuildToolLookups(state);

    expect(state.cachedBrowserTools).toHaveLength(2);
    const firstCached = state.cachedBrowserTools[0];
    expect(firstCached).toBeDefined();
    expect((firstCached as NonNullable<typeof firstCached>).name).toBe('browser_list_tabs');
    const secondCached = state.cachedBrowserTools[1];
    expect(secondCached).toBeDefined();
    expect((secondCached as NonNullable<typeof secondCached>).name).toBe('browser_open_tab');
    // Verify the input schema has the url property
    const openTabSchema = (secondCached as NonNullable<typeof secondCached>).inputSchema;
    expect(openTabSchema).toHaveProperty('properties');
  });
});

describe('rebuildToolLookups — input validation', () => {
  test('lookup entries include a working validate function', () => {
    const state = createState();
    const plugin: RegisteredPlugin = {
      ...createPlugin('test', ['greet']),
      tools: [
        {
          name: 'greet',
          description: 'Greet a user',
          input_schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
          output_schema: { type: 'object' },
        },
      ],
    };
    state.plugins.set('test', plugin);

    rebuildToolLookups(state);

    const entry = state.toolLookup.get('test_greet');
    expect(entry).toBeDefined();
    if (!entry?.validate) throw new Error('Expected validate function');
    expect(entry.validate).toBeInstanceOf(Function);
    // Valid input passes
    expect(entry.validate({ name: 'Alice' })).toBe(true);
    // Missing required field fails
    expect(entry.validate({})).toBe(false);
  });

  test('validationErrors returns human-readable errors after failed validation', () => {
    const state = createState();
    const plugin: RegisteredPlugin = {
      ...createPlugin('test', ['greet']),
      tools: [
        {
          name: 'greet',
          description: 'Greet a user',
          input_schema: {
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'number' } },
            required: ['name'],
            additionalProperties: false,
          },
          output_schema: { type: 'object' },
        },
      ],
    };
    state.plugins.set('test', plugin);
    rebuildToolLookups(state);

    const entry = state.toolLookup.get('test_greet');
    if (!entry?.validate) throw new Error('Expected entry with validate');
    // Pass wrong type for name
    entry.validate({ name: 123 });
    const errors = entry.validationErrors();
    expect(errors).toContain('/name');
    expect(errors).toContain('string');
  });

  test('validate compiles for trivial schemas and passes empty args', () => {
    const state = createState();
    state.plugins.set('test', createPlugin('test', ['ping']));
    rebuildToolLookups(state);

    const entry = state.toolLookup.get('test_ping');
    expect(entry).toBeDefined();
    if (!entry?.validate) throw new Error('Expected validate function');
    // { type: 'object' } compiles successfully — validate should still be a function
    expect(entry.validate).toBeInstanceOf(Function);
    // Empty args should pass a { type: 'object' } schema
    expect(entry.validate({})).toBe(true);
  });

  test('additional properties are rejected when additionalProperties is false', () => {
    const state = createState();
    const plugin: RegisteredPlugin = {
      ...createPlugin('test', ['strict']),
      tools: [
        {
          name: 'strict',
          description: 'Strict tool',
          input_schema: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false,
          },
          output_schema: { type: 'object' },
        },
      ],
    };
    state.plugins.set('test', plugin);
    rebuildToolLookups(state);

    const entry = state.toolLookup.get('test_strict');
    if (!entry?.validate) throw new Error('Expected entry with validate');
    expect(entry.validate({ a: 'ok' })).toBe(true);
    expect(entry.validate({ a: 'ok', b: 'extra' })).toBe(false);
  });
});

describe('trustTierPrefix', () => {
  test('returns correct prefix for official tier', () => {
    expect(trustTierPrefix('official')).toBe('[Official] ');
  });

  test('returns correct prefix for community tier', () => {
    expect(trustTierPrefix('community')).toBe('[Community plugin — unverified] ');
  });

  test('returns correct prefix for local tier', () => {
    expect(trustTierPrefix('local')).toBe('[Local plugin] ');
  });
});
