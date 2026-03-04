import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { OpentabsConfig } from './config.js';
import { loadConfig, saveConfig, savePluginPermissions, writeAuthFile } from './config.js';

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
    expect(config.plugins).toEqual({});

    // File was created on disk
    expect(existsSync(configPath)).toBe(true);
  });

  test('round-trips through save and load', async () => {
    await loadConfig();

    const custom: OpentabsConfig = {
      localPlugins: ['/path/to/plugin-a', '/path/to/plugin-b'],
      plugins: {
        slack: { permission: 'auto', tools: { send_message: 'ask' } },
        discord: { permission: 'off' },
      },
    };
    await saveConfigWrapped(custom);

    const loaded = await loadConfig();
    expect(loaded.localPlugins).toEqual(custom.localPlugins);
    expect(loaded.plugins).toEqual(custom.plugins);
  });

  test('filters non-string elements from localPlugins array', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: ['/valid/path', 123, null, true, '/another/path'],
        plugins: {},
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/valid/path', '/another/path']);
  });

  test('parses valid plugin permission entries and ignores invalid ones', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: [],
        plugins: {
          slack: { permission: 'auto', tools: { send_message: 'ask' } },
          invalid_perm: { permission: 'bogus' },
          invalid_tool_perm: { tools: { foo: 'bogus' } },
          valid_tools_only: { tools: { bar: 'off' } },
          empty_obj: {},
          not_an_object: 'string',
        },
      }),
    );

    const config = await loadConfig();
    expect(config.plugins).toEqual({
      slack: { permission: 'auto', tools: { send_message: 'ask' } },
      valid_tools_only: { tools: { bar: 'off' } },
    });
  });

  test('migrates old-format config with tools/browserToolPolicy to empty plugins', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: ['/some/plugin'],
        tools: { slack_send_message: false, slack_read_messages: true },
        browserToolPolicy: { browser_screenshot_tab: false },
        permissions: {
          trustedDomains: ['localhost'],
          sensitiveDomains: [],
          toolPolicy: {},
          domainToolPolicy: {},
        },
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/some/plugin']);
    // Old tool/browserToolPolicy/permissions are discarded — plugins map is empty
    expect(config.plugins).toEqual({});
    // Old fields are not present on the new config shape
    expect(config).not.toHaveProperty('tools');
    expect(config).not.toHaveProperty('browserToolPolicy');
    expect(config).not.toHaveProperty('permissions');
  });

  test('migrates local paths from legacy plugins array into localPlugins', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: ['/local/plugin', './relative/plugin', 'opentabs-plugin-jira', '@myorg/opentabs-plugin-github'],
      }),
    );

    const config = await loadConfig();
    // Local paths are migrated, npm package names are dropped
    expect(config.localPlugins).toEqual(['/local/plugin', './relative/plugin']);
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
      }),
    );

    const config = await loadConfig();
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
        plugins: {},
        npmPlugins: ['opentabs-plugin-jira', '@myorg/opentabs-plugin-github'],
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/existing/plugin']);
    expect(config).not.toHaveProperty('npmPlugins');
  });

  test('migration deduplicates local paths from plugins array into localPlugins', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: ['/already/here'],
        plugins: ['/already/here', '/new/plugin'],
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
      }),
    );

    const config = await loadConfig();
    expect(config.localPlugins).toEqual(['/some/plugin']);
    expect(config.plugins).toEqual({});
  });

  test('default config has empty plugins map', async () => {
    const config = await loadConfig();
    expect(config.plugins).toEqual({});
    expect(config).not.toHaveProperty('npmPlugins');
  });

  test('preserves skipPermissions flag', async () => {
    const custom: OpentabsConfig = {
      localPlugins: [],
      plugins: {},
      skipPermissions: true,
    };
    await saveConfigWrapped(custom);

    const loaded = await loadConfig();
    expect(loaded.skipPermissions).toBe(true);
  });

  test('migrates skipConfirmation to skipPermissions', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        localPlugins: [],
        plugins: {},
        skipConfirmation: true,
      }),
    );

    const config = await loadConfig();
    expect(config.skipPermissions).toBe(true);
  });
});

describe('savePluginPermissions round-trip', () => {
  beforeEach(async () => {
    process.env.OPENTABS_CONFIG_DIR = TEST_BASE_DIR;
    await removeConfig();
  });

  test('persists plugin permissions without overwriting localPlugins', async () => {
    // Create initial config with localPlugins
    const initial: OpentabsConfig = {
      localPlugins: ['/my/plugin'],
      plugins: {},
    };
    await saveConfigWrapped(initial);

    // Save new plugin permissions via the read-modify-write function
    const state = { configWriteMutex: Promise.resolve() };
    await savePluginPermissions(state, {
      slack: { permission: 'auto' },
      discord: { permission: 'ask', tools: { send_message: 'auto' } },
    });

    // Verify localPlugins are preserved and plugins are updated
    const loaded = await loadConfig();
    expect(loaded.localPlugins).toEqual(['/my/plugin']);
    expect(loaded.plugins).toEqual({
      slack: { permission: 'auto' },
      discord: { permission: 'ask', tools: { send_message: 'auto' } },
    });
  });

  test('overwrites previous plugin permissions completely', async () => {
    const initial: OpentabsConfig = {
      localPlugins: [],
      plugins: { slack: { permission: 'auto' } },
    };
    await saveConfigWrapped(initial);

    const state = { configWriteMutex: Promise.resolve() };
    await savePluginPermissions(state, {
      discord: { permission: 'off' },
    });

    const loaded = await loadConfig();
    // Previous slack entry is gone — replaced by new plugins map
    expect(loaded.plugins).toEqual({
      discord: { permission: 'off' },
    });
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
      plugins: {},
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
      plugins: {},
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

  test.skipIf(isRoot)('savePluginPermissions propagates write errors to the caller', async () => {
    await loadConfig();
    await chmod(TEST_BASE_DIR, 0o555);

    const state = { configWriteMutex: Promise.resolve() };

    await expect(savePluginPermissions(state, { slack: { permission: 'off' } })).rejects.toThrow();

    // Restore permissions for cleanup
    await chmod(TEST_BASE_DIR, 0o700);
  });

  test.skipIf(isRoot)('savePluginPermissions mutex does not deadlock after a failed write', async () => {
    await loadConfig();
    await chmod(TEST_BASE_DIR, 0o555);

    const state = { configWriteMutex: Promise.resolve() };

    // First write fails
    await expect(savePluginPermissions(state, { slack: { permission: 'off' } })).rejects.toThrow();

    // Restore permissions
    await chmod(TEST_BASE_DIR, 0o700);

    // Subsequent write succeeds — the mutex is not deadlocked
    await savePluginPermissions(state, { discord: { permission: 'auto' } });

    const loaded = await loadConfig();
    expect(loaded.plugins).toEqual({ discord: { permission: 'auto' } });
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
