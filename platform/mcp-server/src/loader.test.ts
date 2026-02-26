import {
  checkSdkCompatibility,
  loadPlugin,
  parseMajorMinor,
  pluginNameFromPackage,
  validatePrompts,
  validateResources,
  validateTools,
} from './loader.js';
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

  test('handles third-party scoped packages', () => {
    expect(pluginNameFromPackage('@myorg/opentabs-plugin-jira')).toBe('myorg-jira');
  });

  test('strips official @opentabs-dev scope — treated like unscoped', () => {
    expect(pluginNameFromPackage('@opentabs-dev/opentabs-plugin-slack')).toBe('slack');
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

  /** A 64-char hex string used as the embedded adapter hash in test IIFEs */
  const TEST_ADAPTER_HASH = 'a'.repeat(64);

  /**
   * Minimal IIFE content that includes the embedded __adapterHash pattern,
   * matching the output produced by the build tool's hashAndFreeze snippet.
   */
  const TEST_IIFE = `(function(){window.__test=true})();(function(){var a={};a.__adapterHash="${TEST_ADAPTER_HASH}";})()`;

  /** Write a full plugin directory structure */
  const writePlugin = (
    dir: string,
    packageJson: Record<string, unknown>,
    tools: unknown[] = validTools(),
    iifeContent = TEST_IIFE,
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
    expect(result.value.iife).toBe(TEST_IIFE);
    expect(result.value.tools).toHaveLength(1);
    expect(result.value.tools[0]?.name).toBe('my_tool');
    expect(result.value.sourcePath).toBe(pluginDir);
    expect(result.value.npmPackageName).toBe('opentabs-plugin-test');
    expect(result.value.adapterHash).toBe(TEST_ADAPTER_HASH);
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

  test('extracts adapterHash embedded in IIFE by build tool', async () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const iifeA = `(function(){})();(function(){var a={};a.__adapterHash="${hashA}";})()`;
    const iifeB = `(function(){})();(function(){var a={};a.__adapterHash="${hashB}";})()`;
    const pluginDir1 = join(tmpDir, 'hash1');
    const pluginDir2 = join(tmpDir, 'hash2');
    writePlugin(pluginDir1, validPackageJson(), validTools(), iifeA);
    writePlugin(pluginDir2, validPackageJson(), validTools(), iifeB);

    const result1 = await loadPlugin(pluginDir1, 'local', 'local');
    const result2 = await loadPlugin(pluginDir2, 'local', 'local');

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;
    expect(result1.value.adapterHash).toBe(hashA);
    expect(result2.value.adapterHash).toBe(hashB);
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

  test('extracts sdkVersion from manifest object format', async () => {
    const pluginDir = join(tmpDir, 'with-sdk');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(validPackageJson()));
    writeFileSync(
      join(pluginDir, 'dist', 'tools.json'),
      JSON.stringify({ sdkVersion: '0.0.16', tools: validTools(), resources: [], prompts: [] }),
    );
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sdkVersion).toBe('0.0.16');
  });

  test('sets sdkVersion to undefined for legacy tools.json format (plain array)', async () => {
    const pluginDir = join(tmpDir, 'no-sdk');
    writePlugin(pluginDir, validPackageJson());

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sdkVersion).toBeUndefined();
  });

  test('returns Err for plugin with newer SDK version than server', async () => {
    const pluginDir = join(tmpDir, 'new-sdk');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(validPackageJson()));
    writeFileSync(
      join(pluginDir, 'dist', 'tools.json'),
      JSON.stringify({ sdkVersion: '99.0.0', tools: validTools(), resources: [], prompts: [] }),
    );
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SDK');
      expect(result.error).toContain('99.0.0');
      expect(result.error).toContain('Rebuild the plugin');
    }
  });
});

describe('parseMajorMinor', () => {
  test('parses valid semver into [major, minor]', () => {
    expect(parseMajorMinor('1.2.3')).toEqual([1, 2]);
    expect(parseMajorMinor('0.0.16')).toEqual([0, 0]);
    expect(parseMajorMinor('10.20.30')).toEqual([10, 20]);
  });

  test('returns null for invalid version strings', () => {
    expect(parseMajorMinor('not-a-version')).toBeNull();
    expect(parseMajorMinor('')).toBeNull();
    expect(parseMajorMinor('1.2')).toBeNull();
  });

  test('handles semver with pre-release suffix', () => {
    expect(parseMajorMinor('1.2.3-beta.1')).toEqual([1, 2]);
  });
});

describe('loadPlugin — SVG icon extraction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opentabs-loader-icon-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const writePluginWithManifest = (
    dir: string,
    manifest: Record<string, unknown>,
    packageJson: Record<string, unknown> = {
      name: 'opentabs-plugin-test',
      version: '1.0.0',
      main: 'dist/adapter.iife.js',
      opentabs: { displayName: 'Test', description: 'Test', urlPatterns: ['http://localhost/*'] },
    },
  ) => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
    writeFileSync(join(dir, 'dist', 'tools.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'dist', 'adapter.iife.js'), '(function(){})()');
  };

  test('extracts iconSvg and iconInactiveSvg from manifest object', async () => {
    const pluginDir = join(tmpDir, 'with-icons');
    writePluginWithManifest(pluginDir, {
      sdkVersion: '0.0.16',
      tools: [{ name: 't', displayName: 'T', description: 'T', icon: 'wrench', input_schema: {}, output_schema: {} }],
      resources: [],
      prompts: [],
      iconSvg: '<svg>active</svg>',
      iconInactiveSvg: '<svg>inactive</svg>',
    });

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.iconSvg).toBe('<svg>active</svg>');
    expect(result.value.iconInactiveSvg).toBe('<svg>inactive</svg>');
  });

  test('iconSvg and iconInactiveSvg are undefined when not in manifest', async () => {
    const pluginDir = join(tmpDir, 'no-icons');
    writePluginWithManifest(pluginDir, {
      sdkVersion: '0.0.16',
      tools: [{ name: 't', displayName: 'T', description: 'T', icon: 'wrench', input_schema: {}, output_schema: {} }],
      resources: [],
      prompts: [],
    });

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.iconSvg).toBeUndefined();
    expect(result.value.iconInactiveSvg).toBeUndefined();
  });

  test('iconSvg is undefined when manifest has non-string value', async () => {
    const pluginDir = join(tmpDir, 'bad-icon');
    writePluginWithManifest(pluginDir, {
      sdkVersion: '0.0.16',
      tools: [{ name: 't', displayName: 'T', description: 'T', icon: 'wrench', input_schema: {}, output_schema: {} }],
      resources: [],
      prompts: [],
      iconSvg: 42,
      iconInactiveSvg: true,
    });

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.iconSvg).toBeUndefined();
    expect(result.value.iconInactiveSvg).toBeUndefined();
  });

  test('icons are undefined for legacy plain-array tools.json format', async () => {
    const pluginDir = join(tmpDir, 'legacy');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-test',
        version: '1.0.0',
        main: 'dist/adapter.iife.js',
        opentabs: { displayName: 'Test', description: 'Test', urlPatterns: ['http://localhost/*'] },
      }),
    );
    writeFileSync(
      join(pluginDir, 'dist', 'tools.json'),
      JSON.stringify([
        { name: 't', displayName: 'T', description: 'T', icon: 'wrench', input_schema: {}, output_schema: {} },
      ]),
    );
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    const result = await loadPlugin(pluginDir, 'local', 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.iconSvg).toBeUndefined();
    expect(result.value.iconInactiveSvg).toBeUndefined();
  });
});

describe('validateResources', () => {
  test('validates valid resource entries', () => {
    const resources = [
      { uri: 'slack://channels', name: 'channels', description: 'List channels', mimeType: 'application/json' },
      { uri: 'slack://users', name: 'users' },
    ];
    const result = validateResources(resources, 'test', '/test');
    expect(result).toHaveLength(2);
    expect(result[0]?.uri).toBe('slack://channels');
    expect(result[0]?.mimeType).toBe('application/json');
    expect(result[1]?.description).toBeUndefined();
    expect(result[1]?.mimeType).toBeUndefined();
  });

  test('filters out entries with missing uri', () => {
    const resources = [{ name: 'channels', description: 'List channels' }];
    const result = validateResources(resources, 'test', '/test');
    expect(result).toHaveLength(0);
  });

  test('filters out entries with missing name', () => {
    const resources = [{ uri: 'slack://channels', description: 'List channels' }];
    const result = validateResources(resources, 'test', '/test');
    expect(result).toHaveLength(0);
  });

  test('filters out non-object entries', () => {
    const resources = ['not-an-object', null, 42, { uri: 'ok://uri', name: 'valid' }];
    const result = validateResources(resources, 'test', '/test');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('valid');
  });

  test('filters out entries with non-string description', () => {
    const resources = [{ uri: 'x://y', name: 'r', description: 42 }];
    const result = validateResources(resources, 'test', '/test');
    expect(result).toHaveLength(0);
  });

  test('filters out entries with non-string mimeType', () => {
    const resources = [{ uri: 'x://y', name: 'r', mimeType: true }];
    const result = validateResources(resources, 'test', '/test');
    expect(result).toHaveLength(0);
  });
});

describe('validatePrompts', () => {
  test('validates valid prompt entries', () => {
    const prompts = [
      {
        name: 'greet',
        description: 'Greet user',
        arguments: [{ name: 'name', description: 'User name', required: true }],
      },
      { name: 'help' },
    ];
    const result = validatePrompts(prompts, 'test', '/test');
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('greet');
    expect(result[0]?.arguments).toHaveLength(1);
    expect(result[0]?.arguments?.[0]?.name).toBe('name');
    expect(result[0]?.arguments?.[0]?.required).toBe(true);
    expect(result[1]?.description).toBeUndefined();
    expect(result[1]?.arguments).toBeUndefined();
  });

  test('filters out entries with missing name', () => {
    const prompts = [{ description: 'No name prompt' }];
    const result = validatePrompts(prompts, 'test', '/test');
    expect(result).toHaveLength(0);
  });

  test('filters out non-object entries', () => {
    const prompts = ['string', 42, null, { name: 'valid' }];
    const result = validatePrompts(prompts, 'test', '/test');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('valid');
  });

  test('filters out entries with non-string description', () => {
    const prompts = [{ name: 'p', description: 123 }];
    const result = validatePrompts(prompts, 'test', '/test');
    expect(result).toHaveLength(0);
  });

  test('filters out entries with non-array arguments', () => {
    const prompts = [{ name: 'p', arguments: 'not-array' }];
    const result = validatePrompts(prompts, 'test', '/test');
    expect(result).toHaveLength(0);
  });

  test('filters out invalid arguments within a valid prompt', () => {
    const prompts = [{ name: 'p', arguments: [{ name: 'valid' }, 'not-object', { description: 'no-name' }] }];
    const result = validatePrompts(prompts, 'test', '/test');
    expect(result).toHaveLength(1);
    expect(result[0]?.arguments).toHaveLength(1);
    expect(result[0]?.arguments?.[0]?.name).toBe('valid');
  });
});

describe('loadPlugin — resource and prompt validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opentabs-loader-validate-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const writePluginWithManifest = (dir: string, manifest: Record<string, unknown>) => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-test',
        version: '1.0.0',
        main: 'dist/adapter.iife.js',
        opentabs: { displayName: 'Test', description: 'Test', urlPatterns: ['http://localhost/*'] },
      }),
    );
    writeFileSync(join(dir, 'dist', 'tools.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'dist', 'adapter.iife.js'), '(function(){})()');
  };

  test('filters out invalid resources while loading valid ones', async () => {
    const pluginDir = join(tmpDir, 'mixed-resources');
    writePluginWithManifest(pluginDir, {
      sdkVersion: '0.0.16',
      tools: [{ name: 't', displayName: 'T', description: 'T', icon: 'wrench', input_schema: {}, output_schema: {} }],
      resources: [
        { uri: 'x://valid', name: 'valid', description: 'Valid resource' },
        { name: 'missing-uri' },
        'not-an-object',
      ],
      prompts: [],
    });

    const result = await loadPlugin(pluginDir, 'local', 'local');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resources).toHaveLength(1);
    expect(result.value.resources[0]?.uri).toBe('x://valid');
  });

  test('filters out invalid prompts while loading valid ones', async () => {
    const pluginDir = join(tmpDir, 'mixed-prompts');
    writePluginWithManifest(pluginDir, {
      sdkVersion: '0.0.16',
      tools: [{ name: 't', displayName: 'T', description: 'T', icon: 'wrench', input_schema: {}, output_schema: {} }],
      resources: [],
      prompts: [{ name: 'valid-prompt', description: 'A valid prompt' }, { description: 'missing-name' }, 42],
    });

    const result = await loadPlugin(pluginDir, 'local', 'local');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompts).toHaveLength(1);
    expect(result.value.prompts[0]?.name).toBe('valid-prompt');
  });
});

describe('checkSdkCompatibility', () => {
  test('compatible when plugin sdkVersion is undefined', () => {
    const result = checkSdkCompatibility(undefined, '0.0.16');
    expect(result.compatible).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('compatible when plugin major.minor equals server major.minor', () => {
    const result = checkSdkCompatibility('0.0.16', '0.0.16');
    expect(result.compatible).toBe(true);
  });

  test('compatible when plugin major.minor is older than server', () => {
    const result = checkSdkCompatibility('0.0.10', '0.0.16');
    expect(result.compatible).toBe(true);
  });

  test('compatible with different patch versions (same major.minor)', () => {
    const result = checkSdkCompatibility('1.2.3', '1.2.99');
    expect(result.compatible).toBe(true);
  });

  test('incompatible when plugin minor is newer than server', () => {
    const result = checkSdkCompatibility('0.1.0', '0.0.16');
    expect(result.compatible).toBe(false);
    expect(result.error).toContain('SDK 0.1.0');
    expect(result.error).toContain('SDK 0.0.16');
  });

  test('incompatible when plugin major is newer than server', () => {
    const result = checkSdkCompatibility('2.0.0', '1.5.0');
    expect(result.compatible).toBe(false);
    expect(result.error).toContain('SDK 2.0.0');
    expect(result.error).toContain('SDK 1.5.0');
  });

  test('compatible when plugin version is unparseable', () => {
    const result = checkSdkCompatibility('garbage', '0.0.16');
    expect(result.compatible).toBe(true);
  });

  test('compatible when server version is unparseable', () => {
    const result = checkSdkCompatibility('0.0.16', 'garbage');
    expect(result.compatible).toBe(true);
  });
});
