import { vi, beforeEach, describe, expect, test } from 'vitest';
import type { RegisteredPlugin } from './state.js';
import type * as ChildProcess from 'node:child_process';

// ---- spawnSync mock via vi.mock ----

/** Minimal shape of a spawnSync result used by version-check.ts */
interface SpawnSyncResult {
  error?: Error;
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  pid?: number;
  output?: unknown[];
  signal?: string | null;
}

type SpawnSyncFn = (cmd: string, args: string[], opts: object) => SpawnSyncResult;

const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn<SpawnSyncFn>(),
}));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync: mockSpawnSync,
}));

// Import after mocking so modules pick up the mocked spawnSync
const { fetchLatestVersion, isNewer, checkForUpdates } = await import('./version-check.js');
const { buildRegistry } = await import('./registry.js');
const { createState } = await import('./state.js');

beforeEach(() => {
  mockSpawnSync.mockReset();
});

/** Create a spawnSync-compatible result. */
const makeSpawnResult = (overrides: Partial<SpawnSyncResult> = {}): SpawnSyncResult => ({
  pid: 0,
  output: [],
  stdout: Buffer.from(''),
  stderr: Buffer.from(''),
  status: 0,
  signal: null,
  ...overrides,
});

/** Simulate `npm view <pkg> version` returning a given version or failing. */
const mockNpmView = (version: string | undefined): void => {
  mockSpawnSync.mockReturnValue(
    makeSpawnResult({
      status: version !== undefined ? 0 : 1,
      stdout: Buffer.from(version !== undefined ? `${version}\n` : ''),
      stderr: Buffer.from(version !== undefined ? '' : 'npm ERR! code E404'),
    }),
  );
};

/** Create a minimal RegisteredPlugin for testing */
const makePlugin = (name: string, overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin => ({
  name,
  version: '1.0.0',
  displayName: name,
  urlPatterns: [`https://${name}.example.com/*`],
  trustTier: 'community',
  source: 'local' as const,
  iife: `(function(){})()`,
  tools: [],
  resources: [],
  prompts: [],
  adapterHash: 'abc123',
  ...overrides,
});

describe('isNewer', () => {
  describe('basic comparisons', () => {
    test('newer major version', () => {
      expect(isNewer('1.0.0', '2.0.0')).toBe(true);
    });

    test('newer minor version', () => {
      expect(isNewer('1.0.0', '1.1.0')).toBe(true);
    });

    test('newer patch version', () => {
      expect(isNewer('1.0.0', '1.0.1')).toBe(true);
    });

    test('same version', () => {
      expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    });

    test('older major version', () => {
      expect(isNewer('2.0.0', '1.0.0')).toBe(false);
    });

    test('older minor version', () => {
      expect(isNewer('1.1.0', '1.0.0')).toBe(false);
    });

    test('older patch version', () => {
      expect(isNewer('1.0.1', '1.0.0')).toBe(false);
    });
  });

  describe('v prefix handling', () => {
    test('strips v prefix from current', () => {
      expect(isNewer('v1.0.0', '2.0.0')).toBe(true);
    });

    test('strips v prefix from latest', () => {
      expect(isNewer('1.0.0', 'v2.0.0')).toBe(true);
    });

    test('strips v prefix from both', () => {
      expect(isNewer('v1.0.0', 'v1.0.0')).toBe(false);
    });
  });

  describe('prerelease handling', () => {
    test('prerelease suffix is stripped for comparison (1.0.0-beta.1 treated as 1.0.0)', () => {
      expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(false);
    });

    test('prerelease current vs newer release', () => {
      expect(isNewer('1.0.0-beta.1', '1.0.1')).toBe(true);
    });

    test('prerelease latest vs same base release', () => {
      expect(isNewer('2.0.0', '2.0.0-rc.1')).toBe(false);
    });

    test('prerelease does not cause NaN', () => {
      expect(isNewer('0.9.0', '1.0.0-beta.1')).toBe(true);
    });
  });

  describe('NaN segment handling', () => {
    test('malformed current segment treated as 0 (latest is newer)', () => {
      expect(isNewer('1.0.abc', '2.0.0')).toBe(true);
    });

    test('malformed latest segment treated as 0 (current is newer)', () => {
      expect(isNewer('2.0.0', '1.0.abc')).toBe(false);
    });

    test('both versions have malformed segments', () => {
      expect(isNewer('1.abc.0', '2.xyz.0')).toBe(true);
    });

    test('malformed segment in same position compares as equal (both become 0)', () => {
      expect(isNewer('1.abc.0', '1.xyz.0')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('missing patch version treated as 0', () => {
      expect(isNewer('1.0', '1.0.1')).toBe(true);
    });

    test('handles large version numbers', () => {
      expect(isNewer('1.999.999', '2.0.0')).toBe(true);
    });

    test('major version difference dominates', () => {
      expect(isNewer('1.99.99', '2.0.0')).toBe(true);
      expect(isNewer('2.0.0', '1.99.99')).toBe(false);
    });
  });
});

describe('fetchLatestVersion', () => {
  test('passes package name to npm view', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ stdout: Buffer.from('2.0.0\n') }));

    fetchLatestVersion('my-package');
    expect(mockSpawnSync).toHaveBeenCalledWith('npm', ['view', 'my-package', 'version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  test('scoped package name is passed directly', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ stdout: Buffer.from('1.2.3\n') }));

    fetchLatestVersion('@opentabs-dev/plugin-sdk');
    expect(mockSpawnSync).toHaveBeenCalledWith('npm', ['view', '@opentabs-dev/plugin-sdk', 'version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  test('successful npm view returns version string', () => {
    mockNpmView('3.1.4');
    const result = fetchLatestVersion('some-package');
    expect(result).toBe('3.1.4');
  });

  test('non-zero exit code returns null', () => {
    mockNpmView(undefined);
    const result = fetchLatestVersion('missing-package');
    expect(result).toBeNull();
  });

  test('empty stdout returns null', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ stdout: Buffer.from('') }));

    const result = fetchLatestVersion('some-package');
    expect(result).toBeNull();
  });

  test('spawnSync throwing returns null', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = fetchLatestVersion('some-package');
    expect(result).toBeNull();
  });
});

describe('checkForUpdates', () => {
  test('local plugins (no npmPackageName) are skipped', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ stdout: Buffer.from('2.0.0\n') }));

    const state = createState();
    state.registry = buildRegistry([makePlugin('local-plugin', { trustTier: 'local', npmPackageName: undefined })], []);

    checkForUpdates(state);

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(state.outdatedPlugins).toHaveLength(0);
  });

  test('outdated npm plugin is added to state.outdatedPlugins', () => {
    mockNpmView('2.0.0');

    const state = createState();
    state.registry = buildRegistry(
      [makePlugin('my-plugin', { version: '1.0.0', npmPackageName: 'opentabs-plugin-my' })],
      [],
    );

    checkForUpdates(state);

    expect(state.outdatedPlugins).toHaveLength(1);
    expect(state.outdatedPlugins[0]?.name).toBe('opentabs-plugin-my');
    expect(state.outdatedPlugins[0]?.currentVersion).toBe('1.0.0');
    expect(state.outdatedPlugins[0]?.latestVersion).toBe('2.0.0');
  });

  test('up-to-date plugin is NOT added to state.outdatedPlugins', () => {
    mockNpmView('1.0.0');

    const state = createState();
    state.registry = buildRegistry(
      [makePlugin('my-plugin', { version: '1.0.0', npmPackageName: 'opentabs-plugin-my' })],
      [],
    );

    checkForUpdates(state);

    expect(state.outdatedPlugins).toHaveLength(0);
  });

  test('fetchLatestVersion returning null does not add to outdatedPlugins', () => {
    mockNpmView(undefined);

    const state = createState();
    state.registry = buildRegistry(
      [makePlugin('my-plugin', { version: '1.0.0', npmPackageName: 'opentabs-plugin-my' })],
      [],
    );

    checkForUpdates(state);

    expect(state.outdatedPlugins).toHaveLength(0);
  });

  test('empty plugins map results in empty outdatedPlugins', () => {
    const state = createState();
    checkForUpdates(state);
    expect(state.outdatedPlugins).toHaveLength(0);
  });

  test('mixed results: outdated + failed npm view', () => {
    let callCount = 0;
    mockSpawnSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return makeSpawnResult({ status: 0, stdout: Buffer.from('2.0.0\n') });
      }
      return makeSpawnResult({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('npm ERR! code E404') });
    });

    const state = createState();
    state.registry = buildRegistry(
      [
        makePlugin('plugin-a', { version: '1.0.0', npmPackageName: 'opentabs-plugin-a' }),
        makePlugin('plugin-b', { version: '1.0.0', npmPackageName: 'opentabs-plugin-b' }),
      ],
      [],
    );

    checkForUpdates(state);

    // plugin-a gets version 2.0.0 (outdated), plugin-b npm view fails (skipped)
    expect(state.outdatedPlugins).toHaveLength(1);
    expect(state.outdatedPlugins[0]?.name).toBe('opentabs-plugin-a');
  });
});
