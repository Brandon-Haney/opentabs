import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { OpentabsConfig } from './config.js';
import { loadConfig, saveConfig, saveToolConfig, writeAuthFile } from './config.js';
import type { ServerState } from './state.js';
import { isToolEnabled } from './state.js';

// Override OPENTABS_CONFIG_DIR for test isolation.
// Config functions read this env var lazily on each call.
const TEST_BASE_DIR = mkdtempSync(join(tmpdir(), 'opentabs-config-test-'));
const originalConfigDir = process.env.OPENTABS_CONFIG_DIR;
process.env.OPENTABS_CONFIG_DIR = TEST_BASE_DIR;

const configPath = join(TEST_BASE_DIR, 'config.json');

/** Test wrapper that provides a mock state object with configWriteMutex */
const mockState = { configWriteMutex: Promise.resolve() };
const saveConfigWrapped = (config: OpentabsConfig) => saveConfig(mockState, config);

const removeConfig = async () => {
  try {
    await unlink(configPath);
  } catch {
    // File may not exist
  }
};

describe('loadConfig / saveConfig round-trip', () => {
  beforeEach(async () => {
    await removeConfig();
  });

  afterAll(() => {
    if (originalConfigDir !== undefined) {
      process.env.OPENTABS_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OPENTABS_CONFIG_DIR;
    }
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  });

  test('creates default config on first load', async () => {
    expect(existsSync(configPath)).toBe(false);

    const config = await loadConfig();

    expect(config.localPlugins).toEqual([]);
    expect(config.tools).toEqual({});

    // File was created on disk
    expect(existsSync(configPath)).toBe(true);
  });

  test('round-trips through save and load', async () => {
    await loadConfig();

    const custom: OpentabsConfig = {
      localPlugins: ['/path/to/plugin-a', '/path/to/plugin-b'],
      tools: { slack_send_message: false, slack_read_messages: true },
      browserToolPolicy: {},
      permissions: {
        trustedDomains: ['localhost', '127.0.0.1'],
        sensitiveDomains: [],
        toolPolicy: {},
        domainToolPolicy: {},
      },
    };
    await saveConfigWrapped(custom);

    const loaded = await loadConfig();
    expect(loaded.localPlugins).toEqual(custom.localPlugins);
    expect(loaded.tools).toEqual(custom.tools);
  });

  test('filters non-string elements from localPlugins array', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: ['/valid/path', 123, null, true, '/another/path'],
        tools: {},
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/valid/path', '/another/path']);
  });

  test('filters non-boolean values from tools object', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: [],
        tools: { valid_tool: false, bad_tool: 'yes', another_valid: true, numeric: 1 },
      }),
    );

    const config = await loadConfig();
    expect(config.tools).toEqual({ valid_tool: false, another_valid: true });
  });

  test('migrates local paths from legacy plugins array into localPlugins', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: ['/local/plugin', './relative/plugin', 'opentabs-plugin-jira', '@myorg/opentabs-plugin-github'],
        tools: {},
      }),
    );

    const config = await loadConfig();
    // Local paths are migrated, npm package names are dropped
    expect(config.localPlugins).toEqual(['/local/plugin', './relative/plugin']);
    expect(config).not.toHaveProperty('plugins');
  });

  test('migrates Windows-style paths from legacy plugins array into localPlugins', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: [
          '.\\relative\\plugin',
          '..\\parent\\plugin',
          'C:\\Users\\dev\\plugin',
          'D:/projects/plugin',
          'opentabs-plugin-npm',
        ],
        tools: {},
      }),
    );

    const config = await loadConfig();
    // Windows-style local paths are migrated, npm package names are dropped
    expect(config.localPlugins).toEqual([
      '.\\relative\\plugin',
      '..\\parent\\plugin',
      'C:\\Users\\dev\\plugin',
      'D:/projects/plugin',
    ]);
  });

  test('drops legacy npmPlugins entries with a log notice', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: ['/existing/plugin'],
        tools: {},
        npmPlugins: ['opentabs-plugin-jira', '@myorg/opentabs-plugin-github'],
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/existing/plugin']);
    expect(config).not.toHaveProperty('npmPlugins');
  });

  test('migration deduplicates local paths from plugins into localPlugins', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: ['/already/here'],
        plugins: ['/already/here', '/new/plugin'],
        tools: {},
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/already/here', '/new/plugin']);
  });

  test('ignores absent plugins and npmPlugins fields without error', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: ['/some/plugin'],
        tools: {},
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/some/plugin']);
    expect(config).not.toHaveProperty('plugins');
    expect(config).not.toHaveProperty('npmPlugins');
  });

  test('default config has no plugins or npmPlugins field', async () => {
    const config = await loadConfig();
    expect(config).not.toHaveProperty('plugins');
    expect(config).not.toHaveProperty('npmPlugins');
  });
});

describe('tool config round-trip with isToolEnabled', () => {
  beforeEach(async () => {
    // Re-assert the env var before each test since the prior describe's
    // afterAll restores it, and concurrent test files may also modify it.
    process.env.OPENTABS_CONFIG_DIR = TEST_BASE_DIR;
    await removeConfig();
  });

  test('disabled tools survive save → load cycle and isToolEnabled returns false', async () => {
    await loadConfig();

    const config: OpentabsConfig = {
      localPlugins: [],
      tools: { slack_send: false, slack_read: true },
      browserToolPolicy: {},
      permissions: {
        trustedDomains: ['localhost', '127.0.0.1'],
        sensitiveDomains: [],
        toolPolicy: {},
        domainToolPolicy: {},
      },
    };
    await saveConfigWrapped(config);

    const loaded = await loadConfig();
    expect(loaded.tools.slack_send).toBe(false);
    expect(loaded.tools.slack_read).toBe(true);

    // Verify isToolEnabled integration with loaded config
    const stateWithConfig = { toolConfig: loaded.tools } as ServerState;
    expect(isToolEnabled(stateWithConfig, 'slack_send')).toBe(false);
    expect(isToolEnabled(stateWithConfig, 'slack_read')).toBe(true);
  });

  test('absent tools default to enabled via isToolEnabled', async () => {
    await loadConfig();

    const config: OpentabsConfig = {
      localPlugins: [],
      tools: { slack_send: false },
      browserToolPolicy: {},
      permissions: {
        trustedDomains: ['localhost', '127.0.0.1'],
        sensitiveDomains: [],
        toolPolicy: {},
        domainToolPolicy: {},
      },
    };
    await saveConfigWrapped(config);

    const loaded = await loadConfig();
    const stateWithConfig = { toolConfig: loaded.tools } as ServerState;

    // Tool not in config → isToolEnabled returns true (enabled by default)
    expect(isToolEnabled(stateWithConfig, 'unknown_tool')).toBe(true);
    // Disabled tool → isToolEnabled returns false
    expect(isToolEnabled(stateWithConfig, 'slack_send')).toBe(false);
  });
});

describe('saveConfig error propagation', () => {
  // Root bypasses POSIX file permissions, so chmod-based write-failure
  // simulation does not work when running as root (e.g., Docker containers).
  const isRoot = process.getuid?.() === 0;

  beforeEach(async () => {
    process.env.OPENTABS_CONFIG_DIR = TEST_BASE_DIR;
    await removeConfig();
  });

  test.skipIf(isRoot)('saveConfig propagates write errors to the caller', async () => {
    await loadConfig();
    // Make the directory non-writable so atomicWrite cannot create temp files
    await chmod(TEST_BASE_DIR, 0o555);

    const state = { configWriteMutex: Promise.resolve() };
    const config: OpentabsConfig = {
      localPlugins: [],
      tools: {},
      browserToolPolicy: {},
      permissions: {
        trustedDomains: ['localhost', '127.0.0.1'],
        sensitiveDomains: [],
        toolPolicy: {},
        domainToolPolicy: {},
      },
    };

    await expect(saveConfig(state, config)).rejects.toThrow();

    // Restore permissions for cleanup
    await chmod(TEST_BASE_DIR, 0o700);
  });

  test.skipIf(isRoot)('saveConfig mutex does not deadlock after a failed write', async () => {
    await loadConfig();
    await chmod(TEST_BASE_DIR, 0o555);

    const state = { configWriteMutex: Promise.resolve() };
    const config: OpentabsConfig = {
      localPlugins: ['/test/path'],
      tools: {},
      browserToolPolicy: {},
      permissions: {
        trustedDomains: ['localhost', '127.0.0.1'],
        sensitiveDomains: [],
        toolPolicy: {},
        domainToolPolicy: {},
      },
    };

    // First write fails
    await expect(saveConfig(state, config)).rejects.toThrow();

    // Restore permissions
    await chmod(TEST_BASE_DIR, 0o700);

    // Subsequent write succeeds — the mutex is not deadlocked
    await saveConfig(state, config);

    const loaded = await loadConfig();
    expect(loaded.localPlugins).toEqual(['/test/path']);
  });

  test.skipIf(isRoot)('saveToolConfig propagates write errors to the caller', async () => {
    await loadConfig();
    await chmod(TEST_BASE_DIR, 0o555);

    const state = { configWriteMutex: Promise.resolve() };

    await expect(saveToolConfig(state, { some_tool: false })).rejects.toThrow();

    // Restore permissions for cleanup
    await chmod(TEST_BASE_DIR, 0o700);
  });

  test.skipIf(isRoot)('saveToolConfig mutex does not deadlock after a failed write', async () => {
    await loadConfig();
    await chmod(TEST_BASE_DIR, 0o555);

    const state = { configWriteMutex: Promise.resolve() };

    // First write fails
    await expect(saveToolConfig(state, { some_tool: false })).rejects.toThrow();

    // Restore permissions
    await chmod(TEST_BASE_DIR, 0o700);

    // Subsequent write succeeds — the mutex is not deadlocked
    await saveToolConfig(state, { recovered_tool: true });

    const loaded = await loadConfig();
    expect(loaded.tools).toEqual({ recovered_tool: true });
  });
});

describe('writeAuthFile', () => {
  const authPath = join(TEST_BASE_DIR, 'extension', 'auth.json');

  beforeEach(() => {
    // Re-assert the env var before each test since other test files running
    // concurrently in the same vitest process may have modified it.
    process.env.OPENTABS_CONFIG_DIR = TEST_BASE_DIR;
  });

  test('writes auth.json with secret only (no port)', async () => {
    await writeAuthFile('test-secret-abc');

    expect(existsSync(authPath)).toBe(true);
    const content = JSON.parse(await readFile(authPath, 'utf-8')) as Record<string, unknown>;
    expect(content.secret).toBe('test-secret-abc');
    expect(content).not.toHaveProperty('port');
  });

  test('writes auth.json with restrictive permissions (0600)', async () => {
    await writeAuthFile('perm-test-secret');

    const stats = statSync(authPath);
    // 0o600 = owner read/write only (octal 33188 = 0o100600 including file type bits)
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test('overwrites existing auth.json on subsequent calls', async () => {
    await writeAuthFile('first-secret');
    await writeAuthFile('second-secret');

    const content = JSON.parse(await readFile(authPath, 'utf-8')) as Record<string, unknown>;
    expect(content.secret).toBe('second-secret');
  });
});
