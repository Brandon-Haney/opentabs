import {
  cleanupStaleAdapterFiles,
  cleanupStaleExecFiles,
  ensureAdaptersDir,
  writeAdapterFile,
  writeExecFile,
  EXEC_FILE_PREFIX,
} from './adapter-files.js';
import { getAdaptersDir } from './config.js';
import { createState } from './state.js';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Override OPENTABS_CONFIG_DIR for test isolation.
const TEST_BASE_DIR = mkdtempSync(join(tmpdir(), 'opentabs-adapter-files-test-'));
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

// ─── writeExecFile ───────────────────────────────────────────────────────────

describe('writeExecFile', () => {
  beforeEach(async () => {
    // Reset adaptersDirReady so ensureAdaptersDir creates the directory
    const state = createState();
    await ensureAdaptersDir(state);
  });

  test('wraps user code in an IIFE with Function constructor', async () => {
    const state = createState();
    const filename = await writeExecFile(state, 'test-1', 'return 42');

    expect(filename).toBe(`${EXEC_FILE_PREFIX}test-1.js`);

    const content = await Bun.file(join(getAdaptersDir(), filename)).text();
    // Starts with IIFE wrapper
    expect(content).toStartWith('(function() {');
    expect(content).toEndWith('})();');
    // User code is JSON-escaped inside new Function()
    expect(content).toContain(`new Function(${JSON.stringify('return 42')})`);
    // Contains the result capture mechanism
    expect(content).toContain('__lastExecResult');
    expect(content).toContain('__openTabs');
  });

  test('JSON.stringify escapes special characters in user code', async () => {
    const state = createState();
    const code = 'return "hello\\nworld"';
    const filename = await writeExecFile(state, 'escape-test', code);

    const content = await Bun.file(join(getAdaptersDir(), filename)).text();
    expect(content).toContain(`new Function(${JSON.stringify(code)})`);
  });

  test('handles async code with promise support in wrapper', async () => {
    const state = createState();
    const code = 'return fetch("/api").then(r => r.json())';
    const filename = await writeExecFile(state, 'async-test', code);

    const content = await Bun.file(join(getAdaptersDir(), filename)).text();
    // The wrapper checks for thenable results
    expect(content).toContain('typeof __r.then === "function"');
    expect(content).toContain('__lastExecAsync');
    // Async path: .then() and .catch()
    expect(content).toContain('__r.then(function(v)');
    expect(content).toContain('.catch(function(e)');
  });

  test('malicious code with closing braces cannot break the wrapper', async () => {
    const state = createState();
    const maliciousCode = '});alert(1);//';
    const filename = await writeExecFile(state, 'malicious-test', maliciousCode);

    const content = await Bun.file(join(getAdaptersDir(), filename)).text();
    // The malicious code is safely JSON-escaped inside Function constructor
    expect(content).toContain(`new Function(${JSON.stringify(maliciousCode)})`);
    // The IIFE wrapper is still intact
    expect(content).toStartWith('(function() {');
    expect(content).toEndWith('})();');
  });

  test('creates the adapters directory via ensureAdaptersDir if needed', async () => {
    // Use a fresh temp dir where adapters/ doesn't exist
    const freshDir = mkdtempSync(join(tmpdir(), 'opentabs-adapter-fresh-'));
    const prevConfigDir = Bun.env.OPENTABS_CONFIG_DIR;
    Bun.env.OPENTABS_CONFIG_DIR = freshDir;

    try {
      const state = createState();
      const filename = await writeExecFile(state, 'dir-test', 'return 1');
      const adaptersDir = getAdaptersDir();
      const entries = await readdir(adaptersDir);
      expect(entries).toContain(filename);
    } finally {
      Bun.env.OPENTABS_CONFIG_DIR = prevConfigDir;
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test('error wrapper catches sync exceptions', async () => {
    const state = createState();
    const filename = await writeExecFile(state, 'error-test', 'throw new Error("boom")');

    const content = await Bun.file(join(getAdaptersDir(), filename)).text();
    // The wrapper has a try/catch
    expect(content).toContain('} catch (e) {');
    expect(content).toContain('e instanceof Error ? e.message : String(e)');
  });
});

// ─── writeAdapterFile ────────────────────────────────────────────────────────

describe('writeAdapterFile', () => {
  beforeEach(async () => {
    const state = createState();
    await ensureAdaptersDir(state);
  });

  test('writes IIFE content to adapters directory', async () => {
    const iife = '(function(){console.log("adapter")})();';
    await writeAdapterFile('test-plugin', iife);

    const content = await Bun.file(join(getAdaptersDir(), 'test-plugin.js')).text();
    expect(content).toBe(iife);
  });

  test('rewrites sourceMappingURL when sourceMap is provided', async () => {
    const iife = '(function(){})();\n//# sourceMappingURL=adapter.iife.js.map';
    const sourceMap = '{"version":3,"mappings":""}';
    await writeAdapterFile('my-plugin', iife, sourceMap);

    const content = await Bun.file(join(getAdaptersDir(), 'my-plugin.js')).text();
    expect(content).toContain('//# sourceMappingURL=my-plugin.js.map');
    expect(content).not.toContain('adapter.iife.js.map');

    // Source map file is also written
    const mapContent = await Bun.file(join(getAdaptersDir(), 'my-plugin.js.map')).text();
    expect(mapContent).toBe(sourceMap);
  });

  test('does not rewrite sourceMappingURL when no sourceMap is provided', async () => {
    const iife = '(function(){})();\n//# sourceMappingURL=adapter.iife.js.map';
    await writeAdapterFile('no-map-plugin', iife);

    const content = await Bun.file(join(getAdaptersDir(), 'no-map-plugin.js')).text();
    // sourceMappingURL is left as-is since no source map was provided
    expect(content).toContain('sourceMappingURL=adapter.iife.js.map');
  });
});

// ─── cleanupStaleExecFiles ───────────────────────────────────────────────────

describe('cleanupStaleExecFiles', () => {
  beforeEach(async () => {
    const state = createState();
    await ensureAdaptersDir(state);
  });

  test('removes __exec-*.js files from adapters directory', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, `${EXEC_FILE_PREFIX}abc.js`), 'code');
    await Bun.write(join(adaptersDir, `${EXEC_FILE_PREFIX}def.js`), 'code');

    await cleanupStaleExecFiles();

    const entries = await readdir(adaptersDir);
    expect(entries.filter(f => f.startsWith(EXEC_FILE_PREFIX))).toEqual([]);
  });

  test('removes __exec-*.js.tmp files from adapters directory', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, `${EXEC_FILE_PREFIX}abc.js.tmp`), 'tmp');

    await cleanupStaleExecFiles();

    const entries = await readdir(adaptersDir);
    expect(entries.filter(f => f.startsWith(EXEC_FILE_PREFIX))).toEqual([]);
  });

  test('leaves non-exec files untouched', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, 'my-plugin.js'), 'adapter code');
    await Bun.write(join(adaptersDir, `${EXEC_FILE_PREFIX}stale.js`), 'exec code');

    await cleanupStaleExecFiles();

    const entries = await readdir(adaptersDir);
    expect(entries).toContain('my-plugin.js');
    expect(entries).not.toContain(`${EXEC_FILE_PREFIX}stale.js`);
  });

  test('handles missing adapters directory gracefully', async () => {
    // Point to a directory that does not exist
    const emptyDir = mkdtempSync(join(tmpdir(), 'opentabs-adapter-empty-'));
    const prevConfigDir = Bun.env.OPENTABS_CONFIG_DIR;
    Bun.env.OPENTABS_CONFIG_DIR = emptyDir;

    try {
      // Should not throw
      await cleanupStaleExecFiles();
    } finally {
      Bun.env.OPENTABS_CONFIG_DIR = prevConfigDir;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ─── cleanupStaleAdapterFiles ────────────────────────────────────────────────

describe('cleanupStaleAdapterFiles', () => {
  beforeEach(async () => {
    const state = createState();
    await ensureAdaptersDir(state);
  });

  test('removes .js files for plugins not in current set', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, 'plugin-a.js'), 'a');
    await Bun.write(join(adaptersDir, 'plugin-b.js'), 'b');

    await cleanupStaleAdapterFiles(new Set(['plugin-a']));

    const entries = await readdir(adaptersDir);
    expect(entries).toContain('plugin-a.js');
    expect(entries).not.toContain('plugin-b.js');
  });

  test('removes .js.map files for plugins not in current set', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, 'plugin-a.js'), 'a');
    await Bun.write(join(adaptersDir, 'plugin-a.js.map'), 'map-a');
    await Bun.write(join(adaptersDir, 'plugin-b.js'), 'b');
    await Bun.write(join(adaptersDir, 'plugin-b.js.map'), 'map-b');

    await cleanupStaleAdapterFiles(new Set(['plugin-a']));

    const entries = await readdir(adaptersDir);
    expect(entries).toContain('plugin-a.js');
    expect(entries).toContain('plugin-a.js.map');
    expect(entries).not.toContain('plugin-b.js');
    expect(entries).not.toContain('plugin-b.js.map');
  });

  test('keeps current plugins untouched', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, 'kept-a.js'), 'a');
    await Bun.write(join(adaptersDir, 'kept-b.js'), 'b');

    await cleanupStaleAdapterFiles(new Set(['kept-a', 'kept-b']));

    const entries = await readdir(adaptersDir);
    expect(entries).toContain('kept-a.js');
    expect(entries).toContain('kept-b.js');
  });

  test('does not remove __exec-* files (managed by cleanupStaleExecFiles)', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, `${EXEC_FILE_PREFIX}session.js`), 'exec');

    await cleanupStaleAdapterFiles(new Set());

    const entries = await readdir(adaptersDir);
    expect(entries).toContain(`${EXEC_FILE_PREFIX}session.js`);
  });

  test('does not remove .tmp files', async () => {
    const adaptersDir = getAdaptersDir();
    await Bun.write(join(adaptersDir, 'stale.js.tmp'), 'tmp');

    await cleanupStaleAdapterFiles(new Set());

    const entries = await readdir(adaptersDir);
    expect(entries).toContain('stale.js.tmp');
  });

  test('handles missing adapters directory gracefully', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'opentabs-adapter-nodir-'));
    const prevConfigDir = Bun.env.OPENTABS_CONFIG_DIR;
    Bun.env.OPENTABS_CONFIG_DIR = emptyDir;

    try {
      await cleanupStaleAdapterFiles(new Set(['any']));
    } finally {
      Bun.env.OPENTABS_CONFIG_DIR = prevConfigDir;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
