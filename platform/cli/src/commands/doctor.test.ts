import { checkBunVersion, checkConfigFile, checkExtensionConnected, checkPlugins } from './doctor.js';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckResult } from './doctor.js';

// ---------------------------------------------------------------------------
// checkExtensionConnected
// ---------------------------------------------------------------------------

describe('checkExtensionConnected', () => {
  test('returns warn result when health data is null', () => {
    const result: CheckResult = checkExtensionConnected(null);
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
    expect(result.label).toBe('Extension connection');
    expect(result.detail).toContain('unknown');
  });

  test('returns pass result when extensionConnected is true', () => {
    const result: CheckResult = checkExtensionConnected({ extensionConnected: true });
    expect(result.ok).toBe(true);
    expect(result.label).toBe('Extension connection');
    expect(result.detail).toBe('connected');
  });

  test('returns warn result when extensionConnected is false', () => {
    const result: CheckResult = checkExtensionConnected({ extensionConnected: false });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
    expect(result.label).toBe('Extension connection');
    expect(result.detail).toContain('not connected');
    expect(result.hint).toBeDefined();
  });

  test('returns warn result when extensionConnected is missing', () => {
    const result: CheckResult = checkExtensionConnected({ version: '1.0.0' });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
    expect(result.detail).toContain('not connected');
  });
});

// ---------------------------------------------------------------------------
// checkBunVersion
// ---------------------------------------------------------------------------

describe('checkBunVersion', () => {
  test('returns pass result with current Bun version', () => {
    const result: CheckResult = checkBunVersion();
    expect(result.ok).toBe(true);
    expect(result.label).toBe('Bun runtime');
    expect(result.detail).toContain(Bun.version);
  });
});

// ---------------------------------------------------------------------------
// Test isolation: override config dir for checkConfigFile and checkPlugins
// ---------------------------------------------------------------------------

const TEST_BASE_DIR = mkdtempSync(join(tmpdir(), 'opentabs-cli-doctor-test-'));
const originalConfigDir = Bun.env.OPENTABS_CONFIG_DIR;
Bun.env.OPENTABS_CONFIG_DIR = TEST_BASE_DIR;

afterAll(() => {
  if (originalConfigDir !== undefined) {
    Bun.env.OPENTABS_CONFIG_DIR = originalConfigDir;
  } else {
    delete Bun.env.OPENTABS_CONFIG_DIR;
  }
  rmSync(TEST_BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// checkConfigFile
// ---------------------------------------------------------------------------

describe('checkConfigFile', () => {
  test('returns pass when config file exists', async () => {
    await Bun.write(join(TEST_BASE_DIR, 'config.json'), JSON.stringify({ plugins: [] }));
    const { result, config } = await checkConfigFile();
    expect(result.ok).toBe(true);
    expect(result.label).toBe('Config file');
    expect(result.detail).toContain(TEST_BASE_DIR);
    expect(config).toEqual({ plugins: [] });
  });

  test('returns warn when config file is missing', async () => {
    // Use a subdirectory that has no config.json
    const emptyDir = join(TEST_BASE_DIR, 'empty-config-dir');
    mkdirSync(emptyDir, { recursive: true });
    const prev = Bun.env.OPENTABS_CONFIG_DIR;
    Bun.env.OPENTABS_CONFIG_DIR = emptyDir;
    try {
      const { result, config } = await checkConfigFile();
      expect(result.ok).toBe(false);
      expect(result.fatal).toBe(false);
      expect(result.label).toBe('Config file');
      expect(result.detail).toContain('not found');
      expect(result.hint).toContain('opentabs dev');
      expect(config).toBeNull();
    } finally {
      Bun.env.OPENTABS_CONFIG_DIR = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// checkPlugins
// ---------------------------------------------------------------------------

describe('checkPlugins', () => {
  test('returns warn when config is null', async () => {
    const results = await checkPlugins(null);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.fatal).toBe(false);
    expect(results[0]?.detail).toContain('no config to check');
  });

  test('returns warn when no plugins are configured', async () => {
    const results = await checkPlugins({ plugins: [] });
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.fatal).toBe(false);
    expect(results[0]?.detail).toContain('none configured');
    expect(results[0]?.hint).toContain('opentabs plugin add');
  });

  test('returns fail when plugin directory does not exist', async () => {
    const nonexistentPath = join(TEST_BASE_DIR, 'nonexistent-plugin');
    const config = { plugins: [nonexistentPath] };
    const results = await checkPlugins(config);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.fatal).toBe(true);
    expect(results[0]?.detail).toContain('directory not found');
  });

  test('returns warn when tools.json is missing', async () => {
    const pluginDir = join(TEST_BASE_DIR, 'plugin-no-tools');
    mkdirSync(pluginDir, { recursive: true });
    const config = { plugins: [pluginDir] };
    const results = await checkPlugins(config);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.fatal).toBe(false);
    expect(results[0]?.detail).toContain('tools.json not found');
    expect(results[0]?.hint).toContain('opentabs build');
  });

  test('returns warn when IIFE file is missing', async () => {
    const pluginDir = join(TEST_BASE_DIR, 'plugin-no-iife');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    await Bun.write(join(pluginDir, 'dist', 'tools.json'), JSON.stringify([{ name: 'test' }]));
    const config = { plugins: [pluginDir] };
    const results = await checkPlugins(config);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.fatal).toBe(false);
    expect(results[0]?.detail).toContain('adapter IIFE not found');
    expect(results[0]?.hint).toContain('opentabs build');
  });

  test('returns pass for valid plugin directory with tools.json and IIFE', async () => {
    const pluginDir = join(TEST_BASE_DIR, 'plugin-valid');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    await Bun.write(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'opentabs-plugin-my-plugin', version: '1.0.0' }),
    );
    await Bun.write(join(pluginDir, 'dist', 'tools.json'), JSON.stringify([{ name: 'test' }]));
    await Bun.write(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');
    const config = { plugins: [pluginDir] };
    const results = await checkPlugins(config);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.label).toContain('opentabs-plugin-my-plugin');
    expect(results[0]?.detail).toContain('tools.json + IIFE present');
  });

  test('uses path as label when package.json name is unreadable', async () => {
    const pluginDir = join(TEST_BASE_DIR, 'plugin-bad-package');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    await Bun.write(join(pluginDir, 'package.json'), 'not valid json');
    await Bun.write(join(pluginDir, 'dist', 'tools.json'), JSON.stringify([{ name: 'test' }]));
    await Bun.write(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');
    const config = { plugins: [pluginDir] };
    const results = await checkPlugins(config);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.label).toContain(pluginDir);
  });
});
