import { validatePlugin } from './build.js';
import { describe, expect, test } from 'bun:test';
import type { OpenTabsPlugin, ToolDefinition } from '@opentabs-dev/plugin-sdk';

/**
 * Creates a minimal valid plugin for testing. Override fields as needed.
 * validatePlugin only reads: name, version, description, urlPatterns, tools
 * (and on each tool: name, description). The Zod schemas (input/output) and
 * methods (handle/isReady) are never inspected, so they can be stubs.
 */
const makePlugin = (overrides: Partial<OpenTabsPlugin> = {}): OpenTabsPlugin =>
  ({
    name: 'test-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    urlPatterns: ['https://example.com/*'],
    tools: [makeTool()],
    ...overrides,
  }) as unknown as OpenTabsPlugin;

const makeTool = (overrides: Partial<Pick<ToolDefinition, 'name' | 'description'>> = {}): ToolDefinition =>
  ({
    name: 'test_tool',
    description: 'A test tool',
    ...overrides,
  }) as unknown as ToolDefinition;

// ---------------------------------------------------------------------------
// validatePlugin
// ---------------------------------------------------------------------------

describe('validatePlugin', () => {
  test('returns empty array for a valid plugin', () => {
    expect(validatePlugin(makePlugin())).toEqual([]);
  });

  // -- Name validation --
  describe('name', () => {
    test('rejects empty name', () => {
      const errors = validatePlugin(makePlugin({ name: '' }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.toLowerCase().includes('name'))).toBe(true);
    });

    test('rejects name with uppercase letters', () => {
      const errors = validatePlugin(makePlugin({ name: 'MyPlugin' }));
      expect(errors.length).toBeGreaterThan(0);
    });

    test('rejects reserved name', () => {
      const errors = validatePlugin(makePlugin({ name: 'browser' }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('reserved'))).toBe(true);
    });

    test('accepts valid hyphenated name', () => {
      expect(validatePlugin(makePlugin({ name: 'my-plugin' }))).toEqual([]);
    });
  });

  // -- Version validation --
  describe('version', () => {
    test('rejects empty version', () => {
      const errors = validatePlugin(makePlugin({ version: '' }));
      expect(errors.some(e => e.toLowerCase().includes('version'))).toBe(true);
    });

    test('rejects non-semver version', () => {
      const errors = validatePlugin(makePlugin({ version: 'v1' }));
      expect(errors.some(e => e.includes('semver'))).toBe(true);
    });

    test('rejects version with only major.minor', () => {
      const errors = validatePlugin(makePlugin({ version: '1.0' }));
      expect(errors.some(e => e.includes('semver'))).toBe(true);
    });

    test('accepts valid semver', () => {
      expect(validatePlugin(makePlugin({ version: '1.0.0' }))).toEqual([]);
      expect(validatePlugin(makePlugin({ version: '0.1.0' }))).toEqual([]);
    });

    test('accepts semver with prerelease tag', () => {
      expect(validatePlugin(makePlugin({ version: '1.0.0-beta.1' }))).toEqual([]);
      expect(validatePlugin(makePlugin({ version: '0.0.1-alpha' }))).toEqual([]);
    });
  });

  // -- Description validation --
  describe('description', () => {
    test('rejects empty description', () => {
      const errors = validatePlugin(makePlugin({ description: '' }));
      expect(errors.some(e => e.toLowerCase().includes('description'))).toBe(true);
    });

    test('accepts non-empty description', () => {
      expect(validatePlugin(makePlugin({ description: 'Works' }))).toEqual([]);
    });
  });

  // -- URL patterns validation --
  describe('urlPatterns', () => {
    test('rejects empty urlPatterns array', () => {
      const errors = validatePlugin(makePlugin({ urlPatterns: [] }));
      expect(errors.some(e => e.toLowerCase().includes('url pattern'))).toBe(true);
    });

    test('rejects invalid URL pattern', () => {
      const errors = validatePlugin(makePlugin({ urlPatterns: ['not-a-pattern'] }));
      expect(errors.length).toBeGreaterThan(0);
    });

    test('rejects overly broad pattern', () => {
      const errors = validatePlugin(makePlugin({ urlPatterns: ['*://*/*'] }));
      expect(errors.some(e => e.includes('broad'))).toBe(true);
    });

    test('accepts valid pattern', () => {
      expect(validatePlugin(makePlugin({ urlPatterns: ['https://example.com/*'] }))).toEqual([]);
    });

    test('validates all patterns in the array', () => {
      const errors = validatePlugin(makePlugin({ urlPatterns: ['https://example.com/*', 'bad'] }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // -- Tools validation --
  describe('tools', () => {
    test('rejects empty tools array', () => {
      const errors = validatePlugin(makePlugin({ tools: [] }));
      expect(errors.some(e => e.toLowerCase().includes('tool'))).toBe(true);
    });

    test('rejects tool with empty name', () => {
      const errors = validatePlugin(makePlugin({ tools: [makeTool({ name: '' })] }));
      expect(errors.some(e => e.includes('Tool name is required'))).toBe(true);
    });

    test('rejects tool name that is not snake_case', () => {
      const errors = validatePlugin(makePlugin({ tools: [makeTool({ name: 'CamelCase' })] }));
      expect(errors.some(e => e.includes('snake_case'))).toBe(true);
    });

    test('rejects tool name starting with underscore', () => {
      const errors = validatePlugin(makePlugin({ tools: [makeTool({ name: '_leading' })] }));
      expect(errors.some(e => e.includes('snake_case'))).toBe(true);
    });

    test('rejects tool name with hyphens', () => {
      const errors = validatePlugin(makePlugin({ tools: [makeTool({ name: 'my-tool' })] }));
      expect(errors.some(e => e.includes('snake_case'))).toBe(true);
    });

    test('rejects tool with empty description', () => {
      const errors = validatePlugin(makePlugin({ tools: [makeTool({ description: '' })] }));
      expect(errors.some(e => e.includes('missing a description'))).toBe(true);
    });

    test('rejects duplicate tool names', () => {
      const errors = validatePlugin(
        makePlugin({ tools: [makeTool({ name: 'dup_tool' }), makeTool({ name: 'dup_tool' })] }),
      );
      expect(errors.some(e => e.includes('Duplicate'))).toBe(true);
    });

    test('accepts valid snake_case tool names', () => {
      expect(validatePlugin(makePlugin({ tools: [makeTool({ name: 'send_message' })] }))).toEqual([]);
      expect(validatePlugin(makePlugin({ tools: [makeTool({ name: 'list' })] }))).toEqual([]);
      expect(validatePlugin(makePlugin({ tools: [makeTool({ name: 'a1b2' })] }))).toEqual([]);
    });

    test('accepts multiple valid tools', () => {
      const tools = [makeTool({ name: 'tool_a' }), makeTool({ name: 'tool_b' })];
      expect(validatePlugin(makePlugin({ tools }))).toEqual([]);
    });
  });

  // -- Multiple errors --
  test('collects multiple errors from different fields', () => {
    const errors = validatePlugin(
      makePlugin({
        name: '',
        version: '',
        description: '',
        urlPatterns: [],
        tools: [],
      }),
    );
    // Should have at least one error for each invalid field
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
