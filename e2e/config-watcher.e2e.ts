/**
 * Config watcher E2E tests — verify that modifying config.json automatically
 * triggers plugin discovery without manual hot reload or POST /reload.
 *
 * Key scenarios:
 *   1. Empty config → add plugin path → tools auto-appear in tools/list
 *   2. Config with plugin → remove plugin path → tools auto-disappear
 *   3. Config with plugin → add second plugin → both plugins' tools present
 *   4. Config watcher survives a hot reload and still detects subsequent changes
 *
 * All tests use dynamic ports and isolated config directories. No test calls
 * POST /reload or triggerHotReload — the config file watcher must detect
 * changes automatically.
 */

import {
  test,
  expect,
  startMcpServer,
  createMcpClient,
  cleanupTestConfigDir,
  writeTestConfig,
  createMinimalPlugin,
  readPluginToolNames,
  E2E_TEST_PLUGIN_DIR,
} from './fixtures.js';
import { waitForLog, waitForToolList, BROWSER_TOOL_NAMES } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config watcher — auto-discovery on config.json change
// ---------------------------------------------------------------------------

test.describe('Config watcher — auto-discovery', () => {
  test('adding a plugin path to config.json auto-discovers plugin tools', async () => {
    // Start with empty config (no plugins)
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-cw-add-'));
    writeTestConfig(configDir, { localPlugins: [], tools: {} });

    const server = await startMcpServer(configDir, true);
    const client = createMcpClient(server.port, server.secret);

    try {
      await client.initialize();

      // Wait for config watcher to be set up
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Initially only browser tools should be present
      const toolsBefore = await client.listTools();
      const browserToolSet = new Set(BROWSER_TOOL_NAMES);
      const pluginToolsBefore = toolsBefore.filter(t => !browserToolSet.has(t.name));
      expect(pluginToolsBefore.length).toBe(0);

      for (const bt of BROWSER_TOOL_NAMES) {
        expect(toolsBefore.map(t => t.name)).toContain(bt);
      }

      // Write new config.json with the e2e-test plugin path.
      const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
      const prefixedToolNames = readPluginToolNames();
      const tools: Record<string, boolean> = {};
      for (const t of prefixedToolNames) {
        tools[t] = true;
      }
      writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

      // Poll until plugin tools appear — the config watcher should auto-detect
      // the change without any manual reload
      const toolsAfter = await waitForToolList(
        client,
        list => list.some(t => t.name.startsWith('e2e-test_')),
        15_000,
        300,
        'e2e-test plugin tools to appear after config.json change',
      );

      // Verify all e2e-test plugin tools are present
      const e2eTools = toolsAfter.filter(t => t.name.startsWith('e2e-test_'));
      expect(e2eTools.length).toBe(prefixedToolNames.length);

      // Browser tools should still be present
      for (const bt of BROWSER_TOOL_NAMES) {
        expect(toolsAfter.map(t => t.name)).toContain(bt);
      }
    } finally {
      await client.close();
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });

  test('removing a plugin path from config.json auto-removes plugin tools', async () => {
    // Start with the e2e-test plugin registered
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-cw-remove-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const client = createMcpClient(server.port, server.secret);

    try {
      await client.initialize();

      // Wait for config watcher to be set up
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Verify plugin tools are present initially
      const toolsBefore = await client.listTools();
      const e2eToolsBefore = toolsBefore.filter(t => t.name.startsWith('e2e-test_'));
      expect(e2eToolsBefore.length).toBe(prefixedToolNames.length);

      // Remove the plugin from config.json
      writeTestConfig(configDir, { localPlugins: [], tools: {} });

      // Poll until plugin tools disappear
      const toolsAfter = await waitForToolList(
        client,
        list => !list.some(t => t.name.startsWith('e2e-test_')),
        15_000,
        300,
        'e2e-test plugin tools to disappear after config.json change',
      );

      // Only browser tools should remain
      for (const bt of BROWSER_TOOL_NAMES) {
        expect(toolsAfter.map(t => t.name)).toContain(bt);
      }
    } finally {
      await client.close();
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });

  test('adding a second plugin via config.json auto-discovers both plugins', async () => {
    // Start with the e2e-test plugin registered
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-cw-multi-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const client = createMcpClient(server.port, server.secret);

    // Create a minimal second plugin
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-cw-extra-'));
    const newPluginDir = createMinimalPlugin(tmpDir, 'cw-extra', [
      { name: 'ping', description: 'Ping' },
      { name: 'pong', description: 'Pong' },
    ]);

    try {
      await client.initialize();

      // Wait for config watcher to be set up
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Verify only e2e-test tools are present initially
      const toolsBefore = await client.listTools();
      expect(toolsBefore.some(t => t.name.startsWith('e2e-test_'))).toBe(true);
      expect(toolsBefore.some(t => t.name.startsWith('cw-extra_'))).toBe(false);

      // Add the second plugin to config.json (keeping the first)
      const updatedTools: Record<string, boolean> = { ...tools };
      updatedTools['cw-extra_ping'] = true;
      updatedTools['cw-extra_pong'] = true;
      writeTestConfig(configDir, {
        localPlugins: [absPluginPath, newPluginDir],
        tools: updatedTools,
      });

      // Poll until the new plugin's tools appear
      const toolsAfter = await waitForToolList(
        client,
        list => list.some(t => t.name === 'cw-extra_ping') && list.some(t => t.name === 'cw-extra_pong'),
        15_000,
        300,
        'cw-extra plugin tools to appear after config.json change',
      );

      // Both plugins' tools should be present
      const e2eTools = toolsAfter.filter(t => t.name.startsWith('e2e-test_'));
      expect(e2eTools.length).toBe(prefixedToolNames.length);
      expect(toolsAfter.map(t => t.name)).toContain('cw-extra_ping');
      expect(toolsAfter.map(t => t.name)).toContain('cw-extra_pong');
    } finally {
      await client.close();
      await server.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('config watcher still works after hot reload', async () => {
    // Start with empty config
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-cw-after-hr-'));
    writeTestConfig(configDir, { localPlugins: [], tools: {} });

    const server = await startMcpServer(configDir, true);
    const client = createMcpClient(server.port, server.secret);

    try {
      await client.initialize();

      // Wait for config watcher to be set up
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Trigger a hot reload (this restarts all file watchers including config watcher)
      server.logs.length = 0;
      server.triggerHotReload();
      await waitForLog(server, 'Hot reload complete', 20_000);

      // Verify config watcher was restarted after hot reload
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Now write a config.json change — the restarted config watcher should detect it
      server.logs.length = 0;
      const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
      const prefixedToolNames = readPluginToolNames();
      const tools: Record<string, boolean> = {};
      for (const t of prefixedToolNames) {
        tools[t] = true;
      }
      writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

      // Poll until plugin tools appear via the config watcher (not hot reload)
      const toolsAfter = await waitForToolList(
        client,
        list => list.some(t => t.name.startsWith('e2e-test_')),
        15_000,
        300,
        'e2e-test plugin tools to appear after config.json change (post-hot-reload)',
      );

      const e2eTools = toolsAfter.filter(t => t.name.startsWith('e2e-test_'));
      expect(e2eTools.length).toBe(prefixedToolNames.length);
    } finally {
      await client.close();
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });
});
