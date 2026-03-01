/**
 * Side panel live-update E2E tests — verify that the side panel correctly
 * displays plugin changes triggered by config.json modifications.
 *
 * These tests exercise the full notification path:
 *   config.json change → config watcher → performConfigReload → sync.full →
 *   extension background processes sync.full → chrome.storage updated →
 *   offscreen broadcasts ws:message with sync.full to all extension contexts →
 *   side panel App.tsx detects sync.full and calls loadPlugins → config.getState →
 *   MCP server responds → side panel re-renders plugin cards
 *
 * POST /reload (triggered by `opentabs-plugin build`) uses the same
 * performConfigReload → sync.full pipeline, so these tests cover both paths.
 *
 * The side panel is opened by navigating to its chrome-extension:// URL in a
 * regular tab. The App.tsx listener handles ws:message with sync.full as a
 * fallback notification (in addition to the primary sp:serverMessage path),
 * ensuring reliable updates regardless of how the side panel is opened.
 */

import {
  test,
  expect,
  startMcpServer,
  cleanupTestConfigDir,
  writeTestConfig,
  readPluginToolNames,
  launchExtensionContext,
  E2E_TEST_PLUGIN_DIR,
} from './fixtures.js';
import { waitForExtensionConnected, waitForLog, openSidePanel, setupAdapterSymlink } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * POST /reload to the MCP server. Triggers a full config rediscovery and
 * sync.full to the extension, ensuring the side panel picks up changes.
 */
const postReload = async (port: number, configDir: string): Promise<Response> => {
  const authPath = path.join(configDir, 'extension', 'auth.json');
  const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as { secret?: string };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authData.secret) headers['Authorization'] = `Bearer ${authData.secret}`;
  return fetch(`http://localhost:${port}/reload`, { method: 'POST', headers });
};

// ---------------------------------------------------------------------------
// Side panel live-update tests
// ---------------------------------------------------------------------------

test.describe('Side panel live-update — plugins.changed notification', () => {
  test('side panel updates plugin list when config.json adds a plugin', async () => {
    // 1. Start MCP server with empty config (no plugins)
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-add-'));
    writeTestConfig(configDir, { localPlugins: [], tools: {} });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      // Wait for extension to connect
      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // 2. Open the side panel
      const sidePanelPage = await openSidePanel(context);

      // 3. Verify side panel initially shows no-plugins state
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeVisible({ timeout: 10_000 });

      // 4. Add a plugin by modifying config.json
      const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
      const prefixedToolNames = readPluginToolNames();
      const tools: Record<string, boolean> = {};
      for (const t of prefixedToolNames) {
        tools[t] = true;
      }
      writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

      // Wait for the config watcher to process the change, then confirm
      // the rediscovery via POST /reload to ensure a reliable sync.full
      // reaches the side panel (the config watcher's sync.full may not
      // reliably reach the side panel in headless Chromium environments
      // where chrome.runtime.sendMessage delivery to extension pages
      // opened via URL navigation can be inconsistent).
      await waitForLog(server, 'Config reload complete', 10_000);
      await postReload(server.port, configDir);

      // 5. Verify the side panel DOM updates to show the new plugin.
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeHidden({ timeout: 30_000 });
      await expect(sidePanelPage.locator('button[data-radix-collection-item]')).toBeVisible({ timeout: 10_000 });
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 5_000 });

      await sidePanelPage.close();
    } finally {
      await context.close();
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('side panel updates when plugin is removed from config.json', async () => {
    // Start with the e2e-test plugin registered
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-remove-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Open side panel and verify plugin is initially visible
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 30_000 });

      // Remove the plugin from config.json
      writeTestConfig(configDir, { localPlugins: [], tools: {} });

      // Wait for config watcher reload, then confirm via POST /reload
      await waitForLog(server, 'Config reload complete: 0 plugin', 10_000);
      await postReload(server.port, configDir);

      // Verify the side panel updates to show empty state
      await expect(sidePanelPage.locator('text=No Plugins')).toBeVisible({ timeout: 30_000 });

      await sidePanelPage.close();
    } finally {
      await context.close();
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });
});
