import { applyPolicyEntry, levenshtein, maskSecret, resolveStoredPluginPath, suggestKey } from './config.js';
import { describe, expect, test } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

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

  test('suggests prefix key and appends user suffix for typo in prefix', () => {
    // 'tol.' vs 'tool.' = distance 1; suffix 'slack_send' is appended
    expect(suggestKey('tol.slack_send')).toBe('tool.slack_send');
  });

  test('suggests browser-tool prefix and appends user suffix', () => {
    // 'broser-tool.' vs 'browser-tool.' = distance 1 (missing w)
    expect(suggestKey('broser-tool.my_tool')).toBe('browser-tool.my_tool');
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
    // 'tool' vs 'tool.' = distance 1, no suffix to append
    expect(suggestKey('tool')).toBe('tool.');
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
// applyPolicyEntry
// ---------------------------------------------------------------------------

describe('applyPolicyEntry', () => {
  test('setting enabled removes the key from the map (default state not persisted)', () => {
    const map: Record<string, boolean> = { browser_execute_script: false };
    applyPolicyEntry(map, 'browser_execute_script', true);
    expect(Object.hasOwn(map, 'browser_execute_script')).toBe(false);
  });

  test('setting disabled adds the key with value false', () => {
    const map: Record<string, boolean> = {};
    applyPolicyEntry(map, 'browser_execute_script', false);
    expect(map['browser_execute_script']).toBe(false);
  });

  test('setting enabled on a key that does not exist leaves the map unchanged', () => {
    const map: Record<string, boolean> = {};
    applyPolicyEntry(map, 'browser_screenshot', true);
    expect(Object.hasOwn(map, 'browser_screenshot')).toBe(false);
  });

  test('setting disabled on a key already set to false keeps it false', () => {
    const map: Record<string, boolean> = { browser_execute_script: false };
    applyPolicyEntry(map, 'browser_execute_script', false);
    expect(map['browser_execute_script']).toBe(false);
  });

  test('does not affect other keys in the map', () => {
    const map: Record<string, boolean> = { tool_a: false, tool_b: false };
    applyPolicyEntry(map, 'tool_a', true);
    expect(Object.hasOwn(map, 'tool_a')).toBe(false);
    expect(map['tool_b']).toBe(false);
  });
});
