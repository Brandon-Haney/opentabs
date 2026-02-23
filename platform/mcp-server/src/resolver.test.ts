import { discoverGlobalNpmPlugins, isAllowedPluginPath, resetGlobalPathsCache, resolvePluginPath } from './resolver.js';
import { isErr, isOk } from '@opentabs-dev/shared';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Unit tests for the plugin resolver module.
 *
 * Tests resolvePluginPath() for local path resolution (absolute, relative, ~/),
 * npm package resolution, and security validation. Also tests isAllowedPluginPath()
 * and discoverGlobalNpmPlugins() as the canonical test file for resolver.ts exports.
 */

/** Helper to create a valid plugin directory structure */
const createPluginDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'opentabs-plugin-test',
      version: '1.0.0',
      main: 'dist/adapter.iife.js',
      opentabs: { displayName: 'Test', description: 'A test plugin', urlPatterns: ['http://localhost/*'] },
    }),
  );
};

describe('resolvePluginPath — local absolute paths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opentabs-resolver-path-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolves a valid absolute path to an existing directory', async () => {
    const pluginDir = join(tempDir, 'my-plugin');
    createPluginDir(pluginDir);

    const result = await resolvePluginPath(pluginDir, tempDir);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(pluginDir);
    }
  });

  test('returns error for non-existent absolute path', async () => {
    const nonExistent = join(tempDir, 'does-not-exist');

    const result = await resolvePluginPath(nonExistent, tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain('Path not found');
      expect(result.error).toContain(nonExistent);
    }
  });

  test('returns error when path is a file, not a directory', async () => {
    const filePath = join(tempDir, 'a-file');
    writeFileSync(filePath, 'not a directory');

    const result = await resolvePluginPath(filePath, tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain('not a directory');
    }
  });

  test('returns error for path outside allowed directories', async () => {
    const result = await resolvePluginPath('/etc/evil-plugin', '/etc');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain('outside allowed directories');
    }
  });
});

describe('resolvePluginPath — local relative paths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opentabs-resolver-rel-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolves ./ relative path against configDir', async () => {
    const pluginDir = join(tempDir, 'my-plugin');
    createPluginDir(pluginDir);

    const result = await resolvePluginPath('./my-plugin', tempDir);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(resolve(tempDir, 'my-plugin'));
    }
  });

  test('resolves ../ relative path against configDir', async () => {
    const configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const pluginDir = join(tempDir, 'my-plugin');
    createPluginDir(pluginDir);

    const result = await resolvePluginPath('../my-plugin', join(tempDir, 'config'));

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(resolve(join(tempDir, 'config'), '../my-plugin'));
    }
  });

  test('returns error for relative path pointing to non-existent directory', async () => {
    const result = await resolvePluginPath('./missing', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain('Path not found');
    }
  });
});

describe('resolvePluginPath — ~/ home directory paths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opentabs-resolver-home-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolves ~/ path relative to home directory', async () => {
    // We can't create arbitrary dirs under $HOME, but we can verify the resolved path
    const result = await resolvePluginPath('~/nonexistent-plugin-dir-for-test', tempDir);

    // The path resolves but the directory doesn't exist, so we get a "not found" error
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain(homedir());
    }
  });

  test('resolves ~\\ path relative to home directory (Windows)', async () => {
    const result = await resolvePluginPath('~\\nonexistent-plugin-dir-for-test', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      // Expanded via homedir(), so the error references the home directory path
      expect(result.error).toContain(homedir());
    }
  });
});

describe('resolvePluginPath — npm package specifiers', () => {
  let originalResolveSync: typeof Bun.resolveSync;

  beforeEach(() => {
    originalResolveSync = Bun.resolveSync;
  });

  afterEach(() => {
    Bun.resolveSync = originalResolveSync;
  });

  test('resolves npm package via Bun.resolveSync', async () => {
    const expectedDir = '/fake/node_modules/opentabs-plugin-slack';
    Bun.resolveSync = ((specifier: string, _dir: string) => {
      if (specifier === 'opentabs-plugin-slack/package.json') {
        return expectedDir + '/package.json';
      }
      throw new Error('Not found');
    }) as typeof Bun.resolveSync;

    const result = await resolvePluginPath('opentabs-plugin-slack', '/some/config');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(expectedDir);
    }
  });

  test('returns error for npm package not found', async () => {
    Bun.resolveSync = (() => {
      throw new Error('Module not found');
    }) as typeof Bun.resolveSync;

    const result = await resolvePluginPath('opentabs-plugin-nonexistent', '/some/config');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain('Package not found');
      expect(result.error).toContain('opentabs-plugin-nonexistent');
    }
  });

  test('resolves scoped npm package', async () => {
    const expectedDir = '/fake/node_modules/@myorg/opentabs-plugin-jira';
    Bun.resolveSync = ((specifier: string, _dir: string) => {
      if (specifier === '@myorg/opentabs-plugin-jira/package.json') {
        return expectedDir + '/package.json';
      }
      throw new Error('Not found');
    }) as typeof Bun.resolveSync;

    const result = await resolvePluginPath('@myorg/opentabs-plugin-jira', '/some/config');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(expectedDir);
    }
  });
});

describe('resolvePluginPath — specifier format detection', () => {
  let tempDir: string;
  let originalResolveSync: typeof Bun.resolveSync;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opentabs-resolver-spec-'));
    originalResolveSync = Bun.resolveSync;
  });

  afterEach(() => {
    Bun.resolveSync = originalResolveSync;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('./ prefix is treated as local path', async () => {
    const pluginDir = join(tempDir, 'local-plugin');
    createPluginDir(pluginDir);

    const result = await resolvePluginPath('./local-plugin', tempDir);

    expect(isOk(result)).toBe(true);
  });

  test('../ prefix is treated as local path', async () => {
    const parentPluginDir = join(tempDir, 'parent-plugin');
    createPluginDir(parentPluginDir);

    const dirName = tempDir.split('/').pop() ?? '';
    const result = await resolvePluginPath(`../${dirName}/parent-plugin`, tempDir);

    expect(isOk(result)).toBe(true);
  });

  test('/ prefix is treated as local path', async () => {
    const pluginDir = join(tempDir, 'abs-plugin');
    createPluginDir(pluginDir);

    const result = await resolvePluginPath(pluginDir, '/different/config');

    expect(isOk(result)).toBe(true);
  });

  test('~/ prefix is treated as local path', async () => {
    // ~/ is treated as local — resolves relative to homedir, not as npm
    const result = await resolvePluginPath('~/nonexistent-test-plugin', tempDir);

    // Should fail with a local-path-style error, not "Package not found"
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).not.toContain('Package not found');
    }
  });

  test('~\\ prefix is treated as local path (Windows)', async () => {
    const result = await resolvePluginPath('~\\nonexistent-test-plugin', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).not.toContain('Package not found');
    }
  });

  test('.\\ prefix is treated as local path (Windows)', async () => {
    const result = await resolvePluginPath('.\\my-plugin', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).not.toContain('Package not found');
    }
  });

  test('..\\ prefix is treated as local path (Windows)', async () => {
    const result = await resolvePluginPath('..\\my-plugin', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).not.toContain('Package not found');
    }
  });

  test('drive letter C:\\ is treated as local path (Windows)', async () => {
    const result = await resolvePluginPath('C:\\Users\\dev\\plugins\\foo', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).not.toContain('Package not found');
    }
  });

  test('drive letter D:/ is treated as local path (Windows)', async () => {
    const result = await resolvePluginPath('D:/projects/my-plugin', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).not.toContain('Package not found');
    }
  });

  test('bare name is treated as npm package specifier', async () => {
    Bun.resolveSync = (() => {
      throw new Error('Not found');
    }) as typeof Bun.resolveSync;

    const result = await resolvePluginPath('opentabs-plugin-test', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain('Package not found');
    }
  });

  test('scoped package name is treated as npm package specifier', async () => {
    Bun.resolveSync = (() => {
      throw new Error('Not found');
    }) as typeof Bun.resolveSync;

    const result = await resolvePluginPath('@scope/opentabs-plugin-foo', tempDir);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toContain('Package not found');
    }
  });
});

describe('isAllowedPluginPath', () => {
  test('allows path under home directory', async () => {
    const path = join(homedir(), '.opentabs', 'plugins', 'test');
    expect(await isAllowedPluginPath(path)).toBe(true);
  });

  test('allows path under temp directory', async () => {
    const path = join(tmpdir(), 'opentabs-test', 'plugin');
    expect(await isAllowedPluginPath(path)).toBe(true);
  });

  test('rejects path outside allowed directories', async () => {
    expect(await isAllowedPluginPath('/etc/evil-plugin')).toBe(false);
  });

  test('rejects root path', async () => {
    expect(await isAllowedPluginPath('/')).toBe(false);
  });

  test('allows exact home directory', async () => {
    expect(await isAllowedPluginPath(homedir())).toBe(true);
  });

  test('rejects path that is prefix of home but not a child', async () => {
    const home = homedir();
    expect(await isAllowedPluginPath(home + 'bar')).toBe(false);
  });

  test('rejects path with .. traversal that escapes home', async () => {
    // resolve() normalizes .., but the resulting path must still be under an allowed root
    expect(await isAllowedPluginPath('/var/data/../../../etc/passwd')).toBe(false);
  });
});

describe('discoverGlobalNpmPlugins', () => {
  let tempDir: string;
  let originalSpawnSync: typeof Bun.spawnSync;

  /** Mock result matching the shape returned by Bun.spawnSync */
  const spawnResult = (exitCode: number, stdout: string) =>
    ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from('') }) as ReturnType<typeof Bun.spawnSync>;

  /** Write a valid opentabs plugin package.json */
  const writePluginPkgJson = (dir: string, name: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        main: 'dist/adapter.iife.js',
        opentabs: { displayName: name, description: 'Test plugin', urlPatterns: ['*://*.example.com/*'] },
      }),
    );
  };

  /** Write a package.json without the opentabs field */
  const writeNonPluginPkgJson = (dir: string, name: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  };

  const mockSpawnSync = (handler: (cmd: string[]) => ReturnType<typeof Bun.spawnSync>): void => {
    Bun.spawnSync = ((...args: unknown[]) => {
      const first = args[0];
      const cmd = Array.isArray(first) ? (first as string[]) : (first as { cmd: string[] }).cmd;
      return handler(cmd);
    }) as typeof Bun.spawnSync;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opentabs-resolver-npm-'));
    originalSpawnSync = Bun.spawnSync;
    resetGlobalPathsCache();
  });

  afterEach(() => {
    Bun.spawnSync = originalSpawnSync;
    resetGlobalPathsCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('discovers unscoped opentabs-plugin-* packages', async () => {
    const globalDir = join(tempDir, 'node_modules');
    writePluginPkgJson(join(globalDir, 'opentabs-plugin-slack'), 'opentabs-plugin-slack');

    mockSpawnSync(cmd => {
      if (cmd[0] === 'npm' && cmd[1] === 'root') return spawnResult(0, globalDir);
      return spawnResult(1, '');
    });

    const { dirs, errors } = await discoverGlobalNpmPlugins();

    expect(errors).toHaveLength(0);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(globalDir, 'opentabs-plugin-slack'));
  });

  test('discovers scoped @org/opentabs-plugin-* packages', async () => {
    const globalDir = join(tempDir, 'node_modules');
    writePluginPkgJson(join(globalDir, '@myorg', 'opentabs-plugin-foo'), '@myorg/opentabs-plugin-foo');

    mockSpawnSync(cmd => {
      if (cmd[0] === 'npm' && cmd[1] === 'root') return spawnResult(0, globalDir);
      return spawnResult(1, '');
    });

    const { dirs, errors } = await discoverGlobalNpmPlugins();

    expect(errors).toHaveLength(0);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(globalDir, '@myorg', 'opentabs-plugin-foo'));
  });

  test('skips packages without opentabs field', async () => {
    const globalDir = join(tempDir, 'node_modules');
    writePluginPkgJson(join(globalDir, 'opentabs-plugin-valid'), 'opentabs-plugin-valid');
    writeNonPluginPkgJson(join(globalDir, 'opentabs-plugin-no-field'), 'opentabs-plugin-no-field');

    mockSpawnSync(cmd => {
      if (cmd[0] === 'npm' && cmd[1] === 'root') return spawnResult(0, globalDir);
      return spawnResult(1, '');
    });

    const { dirs } = await discoverGlobalNpmPlugins();

    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(globalDir, 'opentabs-plugin-valid'));
  });

  test('ignores non-plugin packages', async () => {
    const globalDir = join(tempDir, 'node_modules');
    writeNonPluginPkgJson(join(globalDir, 'express'), 'express');
    writeNonPluginPkgJson(join(globalDir, 'lodash'), 'lodash');
    writePluginPkgJson(join(globalDir, 'opentabs-plugin-only'), 'opentabs-plugin-only');

    mockSpawnSync(cmd => {
      if (cmd[0] === 'npm' && cmd[1] === 'root') return spawnResult(0, globalDir);
      return spawnResult(1, '');
    });

    const { dirs } = await discoverGlobalNpmPlugins();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(globalDir, 'opentabs-plugin-only'));
  });

  test('returns empty when no global paths are available', async () => {
    mockSpawnSync(() => spawnResult(1, ''));

    const { dirs, errors } = await discoverGlobalNpmPlugins();

    expect(dirs).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test('returns empty when global directory does not exist', async () => {
    mockSpawnSync(cmd => {
      if (cmd[0] === 'npm' && cmd[1] === 'root') return spawnResult(0, join(tempDir, 'nonexistent'));
      return spawnResult(1, '');
    });

    const { dirs, errors } = await discoverGlobalNpmPlugins();

    expect(dirs).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test('deduplicates plugins found in overlapping npm and bun paths', async () => {
    const globalDir = join(tempDir, 'node_modules');
    writePluginPkgJson(join(globalDir, 'opentabs-plugin-slack'), 'opentabs-plugin-slack');

    // Both npm root and bun pm bin resolve to the same node_modules
    mockSpawnSync(cmd => {
      if (cmd[0] === 'npm' && cmd[1] === 'root') return spawnResult(0, globalDir);
      if (cmd[0] === 'bun' && cmd[1] === 'pm') return spawnResult(0, join(tempDir, 'bin'));
      return spawnResult(1, '');
    });

    const { dirs } = await discoverGlobalNpmPlugins();

    expect(dirs).toHaveLength(1);
  });

  test('caches global paths across calls', async () => {
    const globalDir = join(tempDir, 'node_modules');
    mkdirSync(globalDir, { recursive: true });

    let callCount = 0;
    Bun.spawnSync = ((...args: unknown[]) => {
      callCount++;
      const first = args[0];
      const cmd = Array.isArray(first) ? (first as string[]) : (first as { cmd: string[] }).cmd;
      if (cmd[0] === 'npm' && cmd[1] === 'root') return spawnResult(0, globalDir);
      return spawnResult(1, '');
    }) as typeof Bun.spawnSync;

    await discoverGlobalNpmPlugins();
    const firstCallCount = callCount;

    await discoverGlobalNpmPlugins();
    // Second call should not invoke spawnSync again due to caching
    expect(callCount).toBe(firstCallCount);
  });
});
