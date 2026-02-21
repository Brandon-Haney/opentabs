import { loadPlugin, pluginNameFromPackage, validateTools } from './loader.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Unit tests for the plugin loader module.
 *
 * Uses real temp directories with real files to exercise package.json
 * validation, IIFE reading, tools.json parsing, and name derivation.
 */

/** Minimal valid package.json with opentabs field */
const validPackageJson = (overrides: Record<string, unknown> = {}) => ({
  name: 'opentabs-plugin-test',
  version: '1.0.0',
  main: 'dist/adapter.iife.js',
  opentabs: {
    displayName: 'Test Plugin',
    description: 'A test plugin',
    urlPatterns: ['http://localhost/*'],
  },
  ...overrides,
});

/** Minimal valid tools.json array */
const validTools = (overrides: Array<Record<string, unknown>> = []) =>
  overrides.length > 0
    ? overrides
    : [
        {
          name: 'my_tool',
          displayName: 'My Tool',
          description: 'A tool',
          icon: 'wrench',
          input_schema: {},
          output_schema: {},
        },
      ];

describe('pluginNameFromPackage', () => {
  test('strips opentabs-plugin- prefix', () => {
    expect(pluginNameFromPackage('opentabs-plugin-slack')).toBe('slack');
  });

  test('handles scoped packages', () => {
    expect(pluginNameFromPackage('@myorg/opentabs-plugin-jira')).toBe('myorg-jira');
  });

  test('handles packages without the prefix', () => {
    expect(pluginNameFromPackage('some-other-package')).toBe('some-other-package');
  });
});

describe('validateTools', () => {
  test('validates a valid tools array', () => {
    const result = validateTools(validTools(), '/test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.name).toBe('my_tool');
    }
  });

  test('rejects non-array input', () => {
    const result = validateTools('not an array', '/test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('expected an array');
    }
  });

  test('rejects tool with missing name', () => {
    const result = validateTools(
      [{ displayName: 'X', description: 'Y', icon: 'z', input_schema: {}, output_schema: {} }],
      '/test',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('name must be a non-empty string');
    }
  });

  test('rejects tool with description exceeding 1000 chars', () => {
    const result = validateTools(
      [
        {
          name: 't',
          displayName: 'T',
          description: 'x'.repeat(1001),
          icon: 'i',
          input_schema: {},
          output_schema: {},
        },
      ],
      '/test',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('at most 1000 characters');
    }
  });
});

describe('loadPlugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opentabs-loader-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a full plugin directory structure */
  const writePlugin = (
    dir: string,
    packageJson: Record<string, unknown>,
    tools: unknown[] = validTools(),
    iifeContent = '(function(){window.__test=true})()',
  ) => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
    writeFileSync(join(dir, 'dist', 'tools.json'), JSON.stringify(tools));
    writeFileSync(join(dir, 'dist', 'adapter.iife.js'), iifeContent);
  };

  test('loads a valid plugin with all fields populated', async () => {
    const pluginDir = join(tmpDir, 'my-plugin');
    writePlugin(pluginDir, validPackageJson());

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('test');
    expect(result.value.version).toBe('1.0.0');
    expect(result.value.displayName).toBe('Test Plugin');
    expect(result.value.description).toBe('A test plugin');
    expect(result.value.urlPatterns).toEqual(['http://localhost/*']);
    expect(result.value.trustTier).toBe('local');
    expect(result.value.source).toBe('local');
    expect(result.value.iife).toBe('(function(){window.__test=true})()');
    expect(result.value.tools).toHaveLength(1);
    expect(result.value.tools[0]?.name).toBe('my_tool');
    expect(result.value.sourcePath).toBe(pluginDir);
    expect(result.value.npmPackageName).toBe('opentabs-plugin-test');
    expect(result.value.adapterHash).toBeTypeOf('string');
    expect(result.value.adapterHash?.length).toBe(64);
  });

  test('returns Err when package.json is missing', async () => {
    const pluginDir = join(tmpDir, 'no-pkg');
    mkdirSync(pluginDir, { recursive: true });

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('package.json');
    }
  });

  test('returns Err when IIFE file is missing', async () => {
    const pluginDir = join(tmpDir, 'no-iife');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(validPackageJson()));
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), JSON.stringify(validTools()));

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not found');
    }
  });

  test('returns Err when IIFE file is empty', async () => {
    const pluginDir = join(tmpDir, 'empty-iife');
    writePlugin(pluginDir, validPackageJson(), validTools(), '');

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('empty');
    }
  });

  test('returns Err when IIFE exceeds 5MB size limit', async () => {
    const pluginDir = join(tmpDir, 'oversized');
    const oversizedContent = 'x'.repeat(5 * 1024 * 1024 + 1);
    writePlugin(pluginDir, validPackageJson(), validTools(), oversizedContent);

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('exceeding the 5MB limit');
    }
  });

  test('returns Err when tools.json is missing', async () => {
    const pluginDir = join(tmpDir, 'no-tools');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(validPackageJson()));
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('tools.json');
    }
  });

  test('returns Err when package.json has invalid opentabs field', async () => {
    const pluginDir = join(tmpDir, 'bad-opentabs');
    writePlugin(pluginDir, { ...validPackageJson(), opentabs: 'invalid' });

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('opentabs');
    }
  });

  test('derives plugin name from scoped npm package name', async () => {
    const pluginDir = join(tmpDir, 'scoped');
    writePlugin(pluginDir, validPackageJson({ name: '@myorg/opentabs-plugin-jira' }));

    const result = await loadPlugin(pluginDir, 'community', 'npm');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('myorg-jira');
    expect(result.value.npmPackageName).toBe('@myorg/opentabs-plugin-jira');
  });

  test('computes adapterHash from IIFE content', async () => {
    const pluginDir1 = join(tmpDir, 'hash1');
    const pluginDir2 = join(tmpDir, 'hash2');
    writePlugin(pluginDir1, validPackageJson(), validTools(), 'content-a');
    writePlugin(pluginDir2, validPackageJson(), validTools(), 'content-b');

    const result1 = await loadPlugin(pluginDir1, 'local', 'local');
    const result2 = await loadPlugin(pluginDir2, 'local', 'local');

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;
    expect(result1.value.adapterHash).not.toBe(result2.value.adapterHash);
  });

  test('returns Err for invalid URL patterns', async () => {
    const pluginDir = join(tmpDir, 'bad-url');
    writePlugin(
      pluginDir,
      validPackageJson({ opentabs: { displayName: 'X', description: 'Y', urlPatterns: ['not-a-pattern'] } }),
    );

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('URL pattern');
    }
  });
});
