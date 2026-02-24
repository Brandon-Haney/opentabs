import { handleToolsJsonChange, startConfigWatching, startFileWatching, stopFileWatching } from './file-watcher.js';
import { buildRegistry } from './registry.js';
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
  onPluginDiscovered: () => {},
};

/** Create a minimal registered plugin with the given overrides */
const makePlugin = (overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin => ({
  name: 'test-plugin',
  version: '1.0.0',
  displayName: 'Test Plugin',
  urlPatterns: ['http://localhost/*'],
  trustTier: 'local',
  source: 'local' as const,
  iife: '(function(){})()',
  tools: [],
  resources: [],
  prompts: [],
  ...overrides,
});

describe('file watcher generation counter', () => {
  test('createState initializes fileWatcherGeneration to 0', () => {
    const state = createState();
    expect(state.fileWatching.generation).toBe(0);
  });

  test('startFileWatching increments fileWatcherGeneration', () => {
    const state = createState();
    expect(state.fileWatching.generation).toBe(0);

    startFileWatching(state, noopCallbacks);
    expect(state.fileWatching.generation).toBe(1);

    startFileWatching(state, noopCallbacks);
    expect(state.fileWatching.generation).toBe(2);
  });

  test('stopFileWatching does NOT change fileWatcherGeneration', () => {
    const state = createState();
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatching.generation).toBe(1);

    stopFileWatching(state);
    expect(state.fileWatching.generation).toBe(1);
  });

  test('stale callback with old generation is rejected', () => {
    const state = createState();
    let callbackExecuted = false;

    // Capture generation 0 (simulating what watchPlugin does)
    const capturedGen = state.fileWatching.generation;

    // Bump generation (simulating startFileWatching being called during hot reload)
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatching.generation).toBe(1);

    // Simulate the stale debounce callback check (same pattern as watchPlugin's setTimeout)
    if (state.fileWatching.generation !== capturedGen) {
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
    const capturedGen = state.fileWatching.generation;
    expect(capturedGen).toBe(1);

    // Simulate the debounce callback check — generation matches
    if (state.fileWatching.generation !== capturedGen) {
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
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), '[]');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.registry = buildRegistry([makePlugin({ sourcePath: pluginDir })], []);

    expect(state.fileWatching.generation).toBe(0);
    expect(state.fileWatching.entries).toHaveLength(0);

    startFileWatching(state, noopCallbacks);

    expect(state.fileWatching.generation).toBe(1);
    expect(state.fileWatching.entries).toHaveLength(1);
    const entry = state.fileWatching.entries[0];
    expect(entry).toBeDefined();
    expect((entry as NonNullable<typeof entry>).pluginName).toBe('test-plugin');
  });

  test('restarting file watchers bumps generation and replaces entries', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fw-gen-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), '[]');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.registry = buildRegistry([makePlugin({ sourcePath: pluginDir })], []);

    startFileWatching(state, noopCallbacks);
    expect(state.fileWatching.generation).toBe(1);
    const firstEntries = [...state.fileWatching.entries];

    // Restart watchers (simulating hot reload)
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatching.generation).toBe(2);
    expect(state.fileWatching.entries).toHaveLength(1);

    // Old entries should have been cleaned up (watchers closed)
    // New entries are different instances
    const newEntry = state.fileWatching.entries[0];
    expect(newEntry).toBeDefined();
    expect(newEntry).not.toBe(firstEntries[0]);
  });

  test('stale debounce timer fires after restart but generation check prevents execution', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fw-gen-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), '[]');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.registry = buildRegistry([makePlugin({ sourcePath: pluginDir })], []);

    // Start file watching (generation becomes 1)
    startFileWatching(state, noopCallbacks);
    expect(state.fileWatching.generation).toBe(1);

    // Manually insert a stale timer that captured generation 0
    const staleGen = 0;
    let staleCallbackRan = false;
    const key = `${pluginDir}:test-stale`;
    state.fileWatching.timers.set(
      key,
      setTimeout(() => {
        state.fileWatching.timers.delete(key);
        if (state.fileWatching.generation !== staleGen) return;
        staleCallbackRan = true;
      }, 10),
    );

    // Wait for the timer to fire
    await new Promise(r => setTimeout(r, 50));

    // The stale callback should NOT have executed because generation 0 !== 1
    expect(staleCallbackRan).toBe(false);
    expect(state.fileWatching.timers.has(key)).toBe(false);
  });

  test('current-generation timer fires and executes the callback', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fw-gen-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), '[]');
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})()');

    state = createState();
    state.registry = buildRegistry([makePlugin({ sourcePath: pluginDir })], []);

    // Start file watching (generation becomes 1)
    startFileWatching(state, noopCallbacks);
    const currentGen = state.fileWatching.generation;
    expect(currentGen).toBe(1);

    // Manually insert a timer that captured the current generation
    let currentCallbackRan = false;
    const key = `${pluginDir}:test-current`;
    state.fileWatching.timers.set(
      key,
      setTimeout(() => {
        state.fileWatching.timers.delete(key);
        if (state.fileWatching.generation !== currentGen) return;
        currentCallbackRan = true;
      }, 10),
    );

    // Wait for the timer to fire
    await new Promise(r => setTimeout(r, 50));

    // The current-generation callback should have executed
    expect(currentCallbackRan).toBe(true);
    expect(state.fileWatching.timers.has(key)).toBe(false);
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
    writeFileSync(join(tmpDir, 'config.json'), '{"localPlugins":[]}');
    state = createState();
    return tmpDir;
  };

  test('startConfigWatching sets configWatcher on state', () => {
    setupConfigDir();

    expect(state.fileWatching.configWatcher).toBeNull();

    startConfigWatching(state, noopCallbacks);

    expect(state.fileWatching.configWatcher).not.toBeNull();
  });

  test('stopFileWatching closes config watcher and sets it to null', () => {
    setupConfigDir();

    startConfigWatching(state, noopCallbacks);
    expect(state.fileWatching.configWatcher).not.toBeNull();

    stopFileWatching(state);

    expect(state.fileWatching.configWatcher).toBeNull();
  });

  test('startConfigWatching closes previous config watcher before creating a new one', () => {
    setupConfigDir();

    startConfigWatching(state, noopCallbacks);
    const firstWatcher = state.fileWatching.configWatcher;
    expect(firstWatcher).not.toBeNull();

    startConfigWatching(state, noopCallbacks);
    const secondWatcher = state.fileWatching.configWatcher;
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
    state.fileWatching.generation = 1;
    startConfigWatching(state, callbacks);

    // Write config.json multiple times rapidly
    writeFileSync(join(dir, 'config.json'), '{"localPlugins":["a"]}');
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(join(dir, 'config.json'), '{"localPlugins":["a","b"]}');
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(join(dir, 'config.json'), '{"localPlugins":["a","b","c"]}');

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
    writeFileSync(join(dir, 'config.json'), '{"localPlugins":["stale"]}');

    // Before the debounce fires, bump the generation (simulating a hot reload restart)
    await new Promise(r => setTimeout(r, 50));
    state.fileWatching.generation++;

    // Wait for the debounce timer to fire
    await new Promise(r => setTimeout(r, 400));

    // The callback should NOT have executed because the generation changed
    expect(callCount).toBe(0);
  });
});

// ---- handleToolsJsonChange helpers ----

/**
 * Build a valid dist/tools.json array with one tool.
 */
const makeToolsJson = (overrides: Array<Record<string, unknown>> | null = null): string =>
  JSON.stringify(
    overrides ?? [
      {
        name: 'do_something',
        displayName: 'Do Something',
        description: 'Does something useful',
        icon: 'wrench',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
      },
    ],
  );

/** 64-char hex string to use as an embedded adapter hash */
const EMBEDDED_HASH = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

/** Build an IIFE string that contains the embedded hash-setter snippet */
const makeIifeWithHash = (hash = EMBEDDED_HASH): string => `(function(){/* adapter */})();a.__adapterHash="${hash}";`;

describe('handleToolsJsonChange', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('successful tools.json update modifies plugin state', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'htchange-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), makeToolsJson());
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), makeIifeWithHash());

    const state = createState();
    state.registry = buildRegistry([makePlugin({ adapterHash: 'old-hash' })], []);
    let manifestChangedFor = '';
    const callbacks = {
      ...noopCallbacks,
      onManifestChanged: (name: string) => {
        manifestChangedFor = name;
      },
    };

    await handleToolsJsonChange(state, 'test-plugin', pluginDir, callbacks);

    const plugin = state.registry.plugins.get('test-plugin');
    expect(plugin?.tools).toHaveLength(1);
    expect(plugin?.tools[0]?.name).toBe('do_something');
    expect(manifestChangedFor).toBe('test-plugin');
  });

  test('tools.json file not found logs warning and does not crash', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'htchange-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    // No tools.json written

    const state = createState();
    state.registry = buildRegistry([makePlugin()], []);
    let onManifestChangedCalled = false;
    const callbacks = {
      ...noopCallbacks,
      onManifestChanged: () => {
        onManifestChangedCalled = true;
      },
    };

    await handleToolsJsonChange(state, 'test-plugin', pluginDir, callbacks);
    expect(onManifestChangedCalled).toBe(false);
  });

  test('plugin not in state (stale callback) skips silently', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'htchange-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), makeToolsJson());

    // State has no plugin registered
    const state = createState();
    let onManifestChangedCalled = false;
    const callbacks = {
      ...noopCallbacks,
      onManifestChanged: () => {
        onManifestChangedCalled = true;
      },
    };

    await handleToolsJsonChange(state, 'test-plugin', pluginDir, callbacks);
    expect(onManifestChangedCalled).toBe(false);
  });

  test('IIFE re-read updates adapterHash from embedded hash-setter', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'htchange-'));
    const pluginDir = join(tmpDir, 'test-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'dist', 'tools.json'), makeToolsJson());
    writeFileSync(join(pluginDir, 'dist', 'adapter.iife.js'), makeIifeWithHash(EMBEDDED_HASH));

    const state = createState();
    state.registry = buildRegistry([makePlugin({ adapterHash: 'old-hash' })], []);

    await handleToolsJsonChange(state, 'test-plugin', pluginDir, noopCallbacks);

    // The embedded hash from the IIFE should be set
    expect(state.registry.plugins.get('test-plugin')?.adapterHash).toBe(EMBEDDED_HASH);
  });
});
