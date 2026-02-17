import { startConfigWatching, startFileWatching, stopFileWatching } from './file-watcher.js';
import { createState } from './state.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredPlugin, ServerState } from './state.js';

/** No-op file watcher callbacks */
const noopCallbacks = {
  onManifestChanged: () => {},
  onIifeChanged: () => {},
  onConfigChanged: () => {},
};

/** Create a minimal registered plugin with the given overrides */
const makePlugin = (overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin => ({
  name: 'test-plugin',
  version: '1.0.0',
  urlPatterns: ['http://localhost/*'],
  trustTier: 'local',
  iife: '(function(){})()',
  tools: [],
  ...overrides,
});

describe('file watcher generation counter', () => {
  test('createState initializes fileWatcherGeneration to 0', () => {
    const state = createState();
    expect(state.fileWatcherGeneration).toBe(0);
  });

  test('startFileWatching increments fileWatcherGeneration', () => {
    const state = createState();
    expect(state.fileWatcherGeneration).toBe(0);

    startFileWatching(state, noopCallbacks);
    expect(state.fileWatcherGeneration).toBe(1);

    startFileWatching(state, noopCallbacks);
    expect(state.fileWatcherGeneration).toBe(2);
  });

  test('stopFileWatching does NOT change fileWatcherGeneration', () => {
    const state = createState();
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatcherGeneration).toBe(1);

    stopFileWatching(state);
    expect(state.fileWatcherGeneration).toBe(1);
  });

  test('stale callback with old generation is rejected', () => {
    const state = createState();
    let callbackExecuted = false;

    // Capture generation 0 (simulating what watchPlugin does)
    const capturedGen = state.fileWatcherGeneration;

    // Bump generation (simulating startFileWatching being called during hot reload)
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatcherGeneration).toBe(1);

    // Simulate the stale debounce callback check (same pattern as watchPlugin's setTimeout)
    if (state.fileWatcherGeneration !== capturedGen) {
      // Stale — bail out (this is what the real code does: `return;`)
    } else {
      callbackExecuted = true;
    }

    expect(callbackExecuted).toBe(false);
  });

  test('current-generation callback executes normally', () => {
    const state = createState();
    let callbackExecuted = false;

    // Bump generation via startFileWatching
    startFileWatching(state, noopCallbacks);

    // Capture generation 1 (simulating what watchPlugin does after restart)
    const capturedGen = state.fileWatcherGeneration;
    expect(capturedGen).toBe(1);

    // Simulate the debounce callback check — generation matches
    if (state.fileWatcherGeneration !== capturedGen) {
      // Stale — bail out
    } else {
      callbackExecuted = true;
    }

    expect(callbackExecuted).toBe(true);
  });
});

describe('file watcher lifecycle with real plugins', () => {
  let tmpDir: string;
  let state: ServerState;

  afterEach(() => {
    stopFileWatching(state);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('startFileWatching creates watchers for local plugins and increments generation', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fw-gen-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'opentabs-plugin.json'), '{}');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.plugins.set('test-plugin', makePlugin({ sourcePath: pluginDir }));

    expect(state.fileWatcherGeneration).toBe(0);
    expect(state.fileWatcherEntries).toHaveLength(0);

    startFileWatching(state, noopCallbacks);

    expect(state.fileWatcherGeneration).toBe(1);
    expect(state.fileWatcherEntries).toHaveLength(1);
    const entry = state.fileWatcherEntries[0];
    expect(entry).toBeDefined();
    expect((entry as NonNullable<typeof entry>).pluginName).toBe('test-plugin');
  });

  test('restarting file watchers bumps generation and replaces entries', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fw-gen-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'opentabs-plugin.json'), '{}');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.plugins.set('test-plugin', makePlugin({ sourcePath: pluginDir }));

    startFileWatching(state, noopCallbacks);
    expect(state.fileWatcherGeneration).toBe(1);
    const firstEntries = [...state.fileWatcherEntries];

    // Restart watchers (simulating hot reload)
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatcherGeneration).toBe(2);
    expect(state.fileWatcherEntries).toHaveLength(1);

    // Old entries should have been cleaned up (watchers closed)
    // New entries are different instances
    const newEntry = state.fileWatcherEntries[0];
    expect(newEntry).toBeDefined();
    expect(newEntry).not.toBe(firstEntries[0]);
  });

  test('stale debounce timer fires after restart but generation check prevents execution', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fw-gen-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'opentabs-plugin.json'), '{}');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.plugins.set('test-plugin', makePlugin({ sourcePath: pluginDir }));

    // Start file watching (generation becomes 1)
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatcherGeneration).toBe(1);

    // Manually insert a stale timer that captured generation 0
    const staleGen = 0;
    let staleCallbackRan = false;
    const key = `${pluginDir}:test-stale`;
    state.fileWatcherTimers.set(
      key,
      setTimeout(() => {
        state.fileWatcherTimers.delete(key);
        if (state.fileWatcherGeneration !== staleGen) return;
        staleCallbackRan = true;
      }, 10),
    );

    // Wait for the timer to fire
    await new Promise(r => setTimeout(r, 50));

    // The stale callback should NOT have executed because generation 0 !== 1
    expect(staleCallbackRan).toBe(false);
    expect(state.fileWatcherTimers.has(key)).toBe(false);
  });

  test('current-generation timer fires and executes the callback', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fw-gen-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'opentabs-plugin.json'), '{}');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.plugins.set('test-plugin', makePlugin({ sourcePath: pluginDir }));

    // Start file watching (generation becomes 1)
    startFileWatching(state, noopCallbacks);
    const currentGen = state.fileWatcherGeneration;
    expect(currentGen).toBe(1);

    // Manually insert a timer that captured the current generation
    let currentCallbackRan = false;
    const key = `${pluginDir}:test-current`;
    state.fileWatcherTimers.set(
      key,
      setTimeout(() => {
        state.fileWatcherTimers.delete(key);
        if (state.fileWatcherGeneration !== currentGen) return;
        currentCallbackRan = true;
      }, 10),
    );

    // Wait for the timer to fire
    await new Promise(r => setTimeout(r, 50));

    // The current-generation callback should have executed
    expect(currentCallbackRan).toBe(true);
    expect(state.fileWatcherTimers.has(key)).toBe(false);
  });
});

describe('config file watcher', () => {
  let tmpDir: string;
  let state: ServerState;
  let originalConfigDir: string | undefined;

  afterEach(() => {
    stopFileWatching(state);
    Bun.env.OPENTABS_CONFIG_DIR = originalConfigDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const setupConfigDir = (): string => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-watcher-'));
    originalConfigDir = Bun.env.OPENTABS_CONFIG_DIR;
    Bun.env.OPENTABS_CONFIG_DIR = tmpDir;
    writeFileSync(join(tmpDir, 'config.json'), '{"plugins":[]}');
    state = createState();
    return tmpDir;
  };

  test('startConfigWatching sets configWatcher on state', () => {
    setupConfigDir();

    expect(state.configWatcher).toBeNull();

    startConfigWatching(state, noopCallbacks);

    expect(state.configWatcher).not.toBeNull();
  });

  test('stopFileWatching closes config watcher and sets it to null', () => {
    setupConfigDir();

    startConfigWatching(state, noopCallbacks);
    expect(state.configWatcher).not.toBeNull();

    stopFileWatching(state);

    expect(state.configWatcher).toBeNull();
  });

  test('startConfigWatching closes previous config watcher before creating a new one', () => {
    setupConfigDir();

    startConfigWatching(state, noopCallbacks);
    const firstWatcher = state.configWatcher;
    expect(firstWatcher).not.toBeNull();

    startConfigWatching(state, noopCallbacks);
    const secondWatcher = state.configWatcher;
    expect(secondWatcher).not.toBeNull();
    expect(secondWatcher).not.toBe(firstWatcher);
  });

  test('config watcher debounces rapid changes — only one callback fires', async () => {
    const dir = setupConfigDir();
    let callCount = 0;

    const callbacks = {
      ...noopCallbacks,
      onConfigChanged: () => {
        callCount++;
      },
    };

    // Generation must be > 0 for callbacks to fire (startConfigWatching captures gen)
    state.fileWatcherGeneration = 1;
    startConfigWatching(state, callbacks);

    // Write config.json multiple times rapidly
    writeFileSync(join(dir, 'config.json'), '{"plugins":["a"]}');
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(join(dir, 'config.json'), '{"plugins":["a","b"]}');
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(join(dir, 'config.json'), '{"plugins":["a","b","c"]}');

    // Wait for debounce (200ms) plus buffer for FS event delivery
    await new Promise(r => setTimeout(r, 500));

    // Debounce means only the last change triggers a callback
    expect(callCount).toBe(1);
  });

  test('stale config watcher callbacks are discarded when fileWatcherGeneration changes', async () => {
    const dir = setupConfigDir();
    let callCount = 0;

    const callbacks = {
      ...noopCallbacks,
      onConfigChanged: () => {
        callCount++;
      },
    };

    // Start config watcher at generation 0
    startConfigWatching(state, callbacks);

    // Trigger a config change
    writeFileSync(join(dir, 'config.json'), '{"plugins":["stale"]}');

    // Before the debounce fires, bump the generation (simulating a hot reload restart)
    await new Promise(r => setTimeout(r, 50));
    state.fileWatcherGeneration++;

    // Wait for the debounce timer to fire
    await new Promise(r => setTimeout(r, 400));

    // The callback should NOT have executed because the generation changed
    expect(callCount).toBe(0);
  });
});
