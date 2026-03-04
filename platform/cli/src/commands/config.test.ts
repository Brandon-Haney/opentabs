import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  handleSetLocalPluginsAdd,
  levenshtein,
  maskSecret,
  normalizeConfigForDisplay,
  resolveStoredPluginPath,
  suggestKey,
} from './config.js';

vi.mock('../notify-server.js', () => ({
  notifyServer: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

describe('levenshtein', () => {
  test('identical strings return 0', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  test('both empty strings return 0', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  test('empty string vs non-empty returns length of non-empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
  });

  test('non-empty vs empty string returns length of first', () => {
    expect(levenshtein('abc', '')).toBe(3);
  });

  test('single insertion distance is 1', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
  });

  test('single deletion distance is 1', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  test('single substitution distance is 1', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
  });

  test('completely different strings of same length', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });

  test('is case sensitive', () => {
    expect(levenshtein('ABC', 'abc')).toBe(3);
  });

  test('transposition counts as two edits', () => {
    // 'ab' → 'ba' requires two substitutions (not a transposition algorithm)
    expect(levenshtein('ab', 'ba')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// suggestKey
// ---------------------------------------------------------------------------

describe('suggestKey', () => {
  test('suggests exact match (distance 0)', () => {
    expect(suggestKey('port')).toBe('port');
  });

  test('suggests closest key for single-char typo in non-prefix key', () => {
    // 'prt' vs 'port' = distance 1
    expect(suggestKey('prt')).toBe('port');
  });

  test('returns null when no known key is within distance 2', () => {
    expect(suggestKey('completely_unrelated_nonsense')).toBeNull();
  });

  test('suggests tool-permission prefix and appends user suffix for typo', () => {
    // 'tol-permission.' vs 'tool-permission.' = distance 1
    expect(suggestKey('tol-permission.slack.send')).toBe('tool-permission.slack.send');
  });

  test('suggests plugin-permission prefix and appends user suffix', () => {
    // 'plugn-permission.' vs 'plugin-permission.' = distance 1
    expect(suggestKey('plugn-permission.slack')).toBe('plugin-permission.slack');
  });

  test('suggests localPlugins.add for near-match', () => {
    // 'localPlugins.ad' vs 'localPlugins.add' = distance 1
    expect(suggestKey('localPlugins.ad')).toBe('localPlugins.add');
  });

  test('returns null when distance exceeds 2', () => {
    // 'localPlugins.rem' vs 'localPlugins.remove' = distance 3 (ove)
    expect(suggestKey('localPlugins.rem')).toBeNull();
  });

  test('returns prefix key without suffix when input has no dot', () => {
    // 'port' matches 'port' exactly (distance 0)
    expect(suggestKey('port')).toBe('port');
  });
});

// ---------------------------------------------------------------------------
// maskSecret
// ---------------------------------------------------------------------------

describe('maskSecret', () => {
  test('secrets longer than 8 chars show first4...last4', () => {
    expect(maskSecret('abcdefgh12345678')).toBe('abcd...5678');
  });

  test('secrets exactly 9 chars show first4...last4', () => {
    // slice(0, 4) = 'abcd', slice(-4) = '1234'
    expect(maskSecret('abcde1234')).toBe('abcd...1234');
  });

  test('secrets of exactly 8 chars show ****', () => {
    expect(maskSecret('abcd1234')).toBe('****');
  });

  test('short secrets (less than 8 chars) show ****', () => {
    expect(maskSecret('short')).toBe('****');
  });

  test('empty string shows ****', () => {
    expect(maskSecret('')).toBe('****');
  });
});

// ---------------------------------------------------------------------------
// resolveStoredPluginPath
// ---------------------------------------------------------------------------

describe('resolveStoredPluginPath', () => {
  const configDir = '/home/user/.opentabs';

  test('absolute paths are returned as-is', () => {
    expect(resolveStoredPluginPath('/absolute/path/to/plugin', configDir)).toBe('/absolute/path/to/plugin');
  });

  test('~/  paths expand to homedir', () => {
    const result = resolveStoredPluginPath('~/projects/my-plugin', configDir);
    expect(result).toBe(resolve(homedir(), 'projects/my-plugin'));
  });

  test('relative paths resolve against configDir', () => {
    const result = resolveStoredPluginPath('relative/plugin', configDir);
    expect(result).toBe(resolve(configDir, 'relative/plugin'));
  });

  test('relative path with ./ prefix resolves against configDir', () => {
    const result = resolveStoredPluginPath('./my-plugin', configDir);
    expect(result).toBe(resolve(configDir, './my-plugin'));
  });

  test.runIf(process.platform === 'win32')('Windows drive-letter paths are returned as-is', () => {
    expect(resolveStoredPluginPath('C:\\plugins\\foo', configDir)).toBe('C:\\plugins\\foo');
  });
});

// ---------------------------------------------------------------------------
// normalizeConfigForDisplay
// ---------------------------------------------------------------------------

describe('normalizeConfigForDisplay', () => {
  test('adds plugins: {} when key is absent from config', () => {
    const result = normalizeConfigForDisplay({});
    expect(result.plugins).toEqual({});
  });

  test('preserves existing plugins entries when present', () => {
    const plugins = { slack: { permission: 'auto' } };
    const result = normalizeConfigForDisplay({ plugins });
    expect(result.plugins).toEqual(plugins);
  });

  test('preserves empty object {} plugins as-is', () => {
    const result = normalizeConfigForDisplay({ plugins: {} });
    expect(result.plugins).toEqual({});
  });

  test('preserves all other keys unchanged', () => {
    const config = {
      port: 9000,
      localPlugins: ['/some/plugin'],
    };
    const result = normalizeConfigForDisplay(config);
    expect(result.port).toBe(9000);
    expect(result.localPlugins).toEqual(['/some/plugin']);
  });

  test('does not modify the input config object', () => {
    const config: Record<string, unknown> = {};
    normalizeConfigForDisplay(config);
    expect(Object.hasOwn(config, 'plugins')).toBe(false);
  });

  test('plugins appears in output even for empty config', () => {
    const result = normalizeConfigForDisplay({});
    expect(Object.hasOwn(result, 'plugins')).toBe(true);
    expect(result.plugins).toEqual({});
  });

  test('canonical sections always appear in order: localPlugins, plugins', () => {
    const result = normalizeConfigForDisplay({ localPlugins: [] });
    const keys = Object.keys(result);
    expect(keys.indexOf('localPlugins')).toBeLessThan(keys.indexOf('plugins'));
  });

  test('key ordering is identical whether plugins is present or absent in input', () => {
    const withoutPlugins = normalizeConfigForDisplay({ localPlugins: [] });
    const withPlugins = normalizeConfigForDisplay({
      localPlugins: [],
      plugins: { slack: { permission: 'auto' } },
    });
    expect(Object.keys(withoutPlugins)).toEqual(Object.keys(withPlugins));
  });

  test('non-canonical keys (e.g., port) appear before canonical sections', () => {
    const result = normalizeConfigForDisplay({ port: 9000, localPlugins: [] });
    const keys = Object.keys(result);
    expect(keys.indexOf('port')).toBeLessThan(keys.indexOf('localPlugins'));
    expect(keys.indexOf('port')).toBeLessThan(keys.indexOf('plugins'));
  });
});

// ---------------------------------------------------------------------------
// handleSetLocalPluginsAdd
// ---------------------------------------------------------------------------

describe('handleSetLocalPluginsAdd', () => {
  let testDir: string;
  let exitSpy: MockInstance;
  const savedConfigDir = process.env.OPENTABS_CONFIG_DIR;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'opentabs-addplugin-test-'));
    process.env.OPENTABS_CONFIG_DIR = testDir;
    writeFileSync(join(testDir, 'config.json'), `${JSON.stringify({ localPlugins: [] })}\n`, 'utf-8');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (savedConfigDir !== undefined) {
      process.env.OPENTABS_CONFIG_DIR = savedConfigDir;
    } else {
      delete process.env.OPENTABS_CONFIG_DIR;
    }
    vi.restoreAllMocks();
  });

  test('exits with code 1 and does not write config when path does not exist (no --force)', async () => {
    const nonexistent = join(testDir, 'nonexistent-plugin');

    await expect(handleSetLocalPluginsAdd(nonexistent, {})).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8')) as {
      localPlugins: string[];
    };
    expect(config.localPlugins).toEqual([]);
  });

  test('adds path and warns when path does not exist with --force', async () => {
    const nonexistent = join(testDir, 'future-plugin');
    const warnSpy = vi.spyOn(console, 'log');

    await handleSetLocalPluginsAdd(nonexistent, { force: true });

    const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8')) as {
      localPlugins: string[];
    };
    expect(config.localPlugins).toContain(nonexistent);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Warning: Path does not exist:'));
  });

  test('adds path with warning when directory exists but has no package.json', async () => {
    const pluginDir = join(testDir, 'no-pkg-plugin');
    mkdirSync(pluginDir);
    const warnSpy = vi.spyOn(console, 'log');

    await handleSetLocalPluginsAdd(pluginDir, {});

    const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8')) as {
      localPlugins: string[];
    };
    expect(config.localPlugins).toContain(pluginDir);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No package.json found'));
  });

  test('adds path without warning when directory and package.json both exist', async () => {
    const pluginDir = join(testDir, 'valid-plugin');
    mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'opentabs-plugin-test' }), 'utf-8');
    const warnSpy = vi.spyOn(console, 'log');

    await handleSetLocalPluginsAdd(pluginDir, {});

    const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8')) as {
      localPlugins: string[];
    };
    expect(config.localPlugins).toContain(pluginDir);
    const warnCalls = warnSpy.mock.calls.filter(args => String(args[0]).includes('Warning'));
    expect(warnCalls).toHaveLength(0);
  });
});
