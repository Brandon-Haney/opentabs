import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ScaffoldError, scaffoldPlugin, toPascalCase, toTitleCase } from './scaffold.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe('toTitleCase', () => {
  test('converts hyphenated name to space-separated title case', () => {
    expect(toTitleCase('my-cool-plugin')).toBe('My Cool Plugin');
  });

  test('capitalizes a single word', () => {
    expect(toTitleCase('slack')).toBe('Slack');
  });

  test('handles two-part names', () => {
    expect(toTitleCase('my-plugin')).toBe('My Plugin');
  });
});

describe('toPascalCase', () => {
  test('converts hyphenated name to PascalCase', () => {
    expect(toPascalCase('my-plugin')).toBe('MyPlugin');
  });

  test('capitalizes a single word', () => {
    expect(toPascalCase('slack')).toBe('Slack');
  });

  test('converts multi-part hyphenated name', () => {
    expect(toPascalCase('my-cool-plugin')).toBe('MyCoolPlugin');
  });
});

describe('scaffoldPlugin', () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opentabs-scaffold-test-'));
    originalCwd = process.cwd();
    originalConfigDir = process.env.OPENTABS_CONFIG_DIR;

    // Change cwd so scaffoldPlugin creates projects in the temp dir
    process.chdir(tmpDir);
    // Point config to temp dir for test isolation
    process.env.OPENTABS_CONFIG_DIR = join(tmpDir, '.opentabs');
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.chdir(originalCwd);
    if (originalConfigDir !== undefined) {
      process.env.OPENTABS_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OPENTABS_CONFIG_DIR;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid scaffold creates expected file structure', async () => {
    await scaffoldPlugin({ name: 'test-plugin', domain: 'example.com' });

    const projectDir = join(tmpDir, 'test-plugin');
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'src', 'tools', 'example.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'biome.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(true);
  });

  test("domain 'slack.com' produces URL pattern '*://slack.com/*'", async () => {
    await scaffoldPlugin({ name: 'slack', domain: 'slack.com' });

    const indexContent = await readFile(join(tmpDir, 'slack', 'src', 'index.ts'), 'utf-8');
    expect(indexContent).toContain('*://slack.com/*');
  });

  test("domain '.slack.com' produces URL pattern '*://*.slack.com/*'", async () => {
    await scaffoldPlugin({ name: 'wildcard', domain: '.slack.com' });

    const indexContent = await readFile(join(tmpDir, 'wildcard', 'src', 'index.ts'), 'utf-8');
    expect(indexContent).toContain('*://*.slack.com/*');
  });

  test('invalid name throws ScaffoldError', async () => {
    let caught: Error | undefined;
    try {
      await scaffoldPlugin({ name: 'INVALID NAME!', domain: 'example.com' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(ScaffoldError);
  });

  test('existing directory throws ScaffoldError', async () => {
    const existingDir = join(tmpDir, 'existing');
    mkdirSync(existingDir, { recursive: true });

    let caught: Error | undefined;
    try {
      await scaffoldPlugin({ name: 'existing', domain: 'example.com' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(ScaffoldError);
    expect(caught?.message).toContain('already exists');
  });

  test('scaffolded biome.json includes linter rules and formatter settings', async () => {
    await scaffoldPlugin({ name: 'test-plugin', domain: 'example.com' });

    const biomeConfig = await readFile(join(tmpDir, 'test-plugin', 'biome.json'), 'utf-8');
    const config = JSON.parse(biomeConfig);
    expect(config.$schema).toContain('biomejs.dev');
    expect(config.javascript.formatter.quoteStyle).toBe('single');
    expect(config.linter.rules.correctness.noUnusedVariables).toBe('error');
  });

  test('cleans up partial directory if a file write fails, allowing retry', async () => {
    const fsp = await import('node:fs/promises');
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(new Error('Disk full'));

    const projectDir = join(tmpDir, 'cleanup-test');

    await expect(scaffoldPlugin({ name: 'cleanup-test', domain: 'example.com' })).rejects.toThrow('Disk full');

    expect(existsSync(projectDir)).toBe(false);

    // Retry with same name succeeds now that the partial dir was cleaned up
    await expect(scaffoldPlugin({ name: 'cleanup-test', domain: 'example.com' })).resolves.toBeDefined();
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
  });
});
