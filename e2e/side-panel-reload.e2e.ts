/**
 * Side panel auto-refresh E2E tests — verify that the side panel updates
 * automatically when POST /reload triggers plugin rediscovery.
 *
 * These tests exercise the full POST /reload pipeline:
 *   POST /reload → performConfigReload → reloadCore → sendSyncFull →
 *   extension background processes sync.full → chrome.storage updated →
 *   offscreen broadcasts ws:message → side panel detects change and re-renders
 *
 * Unlike the config-watcher tests in side-panel-live-update.e2e.ts (which rely
 * on the dev-mode file watcher to detect config.json changes), these tests
 * explicitly trigger rediscovery via the HTTP endpoint — simulating what
 * `opentabs-plugin build` does after compiling a plugin.
 */

import {
  test,
  expect,
  startMcpServer,
  cleanupTestConfigDir,
  writeTestConfig,
  readTestConfig,
  readPluginToolNames,
  launchExtensionContext,
  E2E_TEST_PLUGIN_DIR,
} from './fixtures.js';
import { waitForExtensionConnected, waitForLog, openSidePanel, setupAdapterSymlink } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Build a tools map from the e2e-test plugin's prefixed tool names. */
const buildToolsMap = (): Record<string, boolean> => {
  const tools: Record<string, boolean> = {};
  for (const t of readPluginToolNames()) {
    tools[t] = true;
  }
  return tools;
};

/** POST /reload with Bearer auth. Reads secret from the server's config. */
const postReload = async (port: number, configDir: string): Promise<Response> => {
  const config = readTestConfig(configDir);
  const secret = config.secret ?? '';
  return fetch(`http://localhost:${String(port)}/reload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
};

// ---------------------------------------------------------------------------
// Side panel auto-refresh via POST /reload
// ---------------------------------------------------------------------------

test.describe('Side panel auto-refresh — POST /reload', () => {
  test('side panel reflects plugin removal after POST /reload', async () => {
    // Start with the e2e-test plugin registered (same pattern as live-update tests)
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const tools = buildToolsMap();

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-reload-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Open side panel and verify plugin is visible
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 30_000 });

      // Remove the plugin from config, preserving the server's auto-generated secret
      const currentConfig = readTestConfig(configDir);
      writeTestConfig(configDir, { localPlugins: [], tools: {}, secret: currentConfig.secret });

      // Wait for the config watcher to process the change before calling POST /reload.
      // This avoids a race between the two reload paths (config watcher vs HTTP endpoint).
      await waitForLog(server, 'Config reload complete: 0 plugin', 10_000);

      // POST /reload confirms the rediscovery and triggers another sync.full
      const reloadRes = await postReload(server.port, configDir);
      expect(reloadRes.ok).toBe(true);
      const body = (await reloadRes.json()) as { ok: boolean; plugins: number };
      expect(body.plugins).toBe(0);

      // Verify the side panel shows the empty state (from the sync.full pipeline)
      await expect(sidePanelPage.locator('text=No Plugins')).toBeVisible({ timeout: 30_000 });

      await sidePanelPage.close();
    } finally {
      await context.close();
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('side panel reflects plugin addition after POST /reload', async () => {
    // Start with empty config (no plugins)
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-reload-add-'));
    writeTestConfig(configDir, { localPlugins: [], tools: {} });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Open side panel and verify onboarding state
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeVisible({ timeout: 10_000 });

      // Add plugin to config, preserving the server's auto-generated secret
      const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
      const tools = buildToolsMap();
      const currentConfig = readTestConfig(configDir);
      writeTestConfig(configDir, { localPlugins: [absPluginPath], tools, secret: currentConfig.secret });

      // Wait for the config watcher to process the change before calling POST /reload
      await waitForLog(server, 'Config reload complete: 1 plugin', 10_000);

      // POST /reload confirms the rediscovery and triggers another sync.full
      const reloadRes = await postReload(server.port, configDir);
      expect(reloadRes.ok).toBe(true);
      const body = (await reloadRes.json()) as { ok: boolean; plugins: number };
      expect(body.plugins).toBeGreaterThan(0);

      // Verify the side panel shows the plugin (from the sync.full pipeline)
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeHidden({ timeout: 30_000 });
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 10_000 });

      await sidePanelPage.close();
    } finally {
      await context.close();
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('side panel preserves plugin state after POST /reload without config change', async () => {
    // Start with the e2e-test plugin registered
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const tools = buildToolsMap();

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-reload-noop-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Open side panel and verify plugin is visible
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 30_000 });

      // Trigger POST /reload WITHOUT changing config — plugin should remain
      const reloadRes = await postReload(server.port, configDir);
      expect(reloadRes.ok).toBe(true);
      const body = (await reloadRes.json()) as { ok: boolean; plugins: number };
      expect(body.ok).toBe(true);
      expect(body.plugins).toBeGreaterThan(0);

      // Verify the side panel still shows the plugin after reload
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 5_000 });

      await sidePanelPage.close();
    } finally {
      await context.close();
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });
});
