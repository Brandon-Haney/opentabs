/**
 * Side panel empty-state E2E tests — verify side panel state transitions
 * for empty plugins, plugin discovery, and disconnection.
 *
 * These tests exercise the side panel's state machine:
 *   - 0 plugins → "No Plugins Installed" card
 *   - Adding a plugin → transition to plugin list
 *   - Server disconnect → "Cannot Reach MCP Server" card
 *
 * All tests use dynamic ports and isolated config directories.
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
import type { McpServer } from './fixtures.js';
import type { BrowserContext } from '@playwright/test';

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
// Empty state tests
// ---------------------------------------------------------------------------

test.describe('Empty states', () => {
  test('extension with 0 plugins shows no-plugins card with opentabs plugin command', async () => {
    // Start MCP server with empty config (no plugins)
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-empty-fresh-'));
    writeTestConfig(configDir, { localPlugins: [], tools: {} });

    let server: McpServer | undefined;
    let context: BrowserContext | undefined;
    let cleanupDir = '';
    try {
      server = await startMcpServer(configDir, true);
      const ext = await launchExtensionContext(server.port, server.secret);
      context = ext.context;
      cleanupDir = ext.cleanupDir;
      setupAdapterSymlink(configDir, ext.extensionDir);

      await waitForExtensionConnected(server);

      // Open the side panel
      const sidePanelPage = await openSidePanel(context);

      // Verify the no-plugins heading is visible
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeVisible({ timeout: 10_000 });

      // The opentabs plugin command should be present
      await expect(sidePanelPage.locator('text=opentabs plugin')).toBeVisible({ timeout: 5_000 });

      await sidePanelPage.close();
    } finally {
      await context?.close();
      await server?.kill();
      if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('adding a plugin transitions the side panel from no-plugins to plugin list', async () => {
    // Start MCP server with empty config (no plugins)
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-empty-transition-'));
    writeTestConfig(configDir, { localPlugins: [], tools: {} });

    let server: McpServer | undefined;
    let context: BrowserContext | undefined;
    let cleanupDir = '';
    try {
      server = await startMcpServer(configDir, true);
      const ext = await launchExtensionContext(server.port, server.secret);
      context = ext.context;
      cleanupDir = ext.cleanupDir;
      setupAdapterSymlink(configDir, ext.extensionDir);

      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Open the side panel and verify no-plugins state
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeVisible({ timeout: 10_000 });

      // Add a plugin via config.json modification
      const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
      const prefixedToolNames = readPluginToolNames();
      const tools: Record<string, boolean> = {};
      for (const t of prefixedToolNames) {
        tools[t] = true;
      }
      writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

      // Wait for the config watcher to process the change, then confirm
      // via POST /reload so a reliable sync.full reaches the side panel.
      await waitForLog(server, 'Config reload complete', 10_000);
      await postReload(server.port, configDir);

      // Verify the no-plugins view disappears and the plugin list appears
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeHidden({ timeout: 30_000 });
      await expect(sidePanelPage.locator('button[aria-expanded]')).toBeVisible({ timeout: 10_000 });
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 5_000 });

      await sidePanelPage.close();
    } finally {
      await context?.close();
      await server?.kill();
      if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('disconnected state shows when server stops, not no-plugins', async () => {
    // Start MCP server with empty config (no plugins)
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-empty-disconnect-'));
    writeTestConfig(configDir, { localPlugins: [], tools: {} });

    let server: McpServer | undefined;
    let context: BrowserContext | undefined;
    let cleanupDir = '';
    try {
      server = await startMcpServer(configDir, true);
      const ext = await launchExtensionContext(server.port, server.secret);
      context = ext.context;
      cleanupDir = ext.cleanupDir;
      setupAdapterSymlink(configDir, ext.extensionDir);

      await waitForExtensionConnected(server);

      // Open the side panel and verify no-plugins state
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeVisible({ timeout: 10_000 });

      // Kill the MCP server
      await server.kill();

      // Verify the disconnected state appears (not no-plugins)
      await expect(sidePanelPage.locator('text=Cannot Reach MCP Server')).toBeVisible({ timeout: 30_000 });
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeHidden({ timeout: 5_000 });

      await sidePanelPage.close();
    } finally {
      await context?.close();
      await server?.kill();
      if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('removing all plugins shows no-plugins card', async () => {
    // Start MCP server WITH the e2e-test plugin
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-empty-remove-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    let server: McpServer | undefined;
    let context: BrowserContext | undefined;
    let cleanupDir = '';
    try {
      server = await startMcpServer(configDir, true);
      const ext = await launchExtensionContext(server.port, server.secret);
      context = ext.context;
      cleanupDir = ext.cleanupDir;
      setupAdapterSymlink(configDir, ext.extensionDir);

      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // Open the side panel and verify plugin is visible
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.locator('text=E2E Test')).toBeVisible({ timeout: 30_000 });

      // Remove all plugins via config.json
      writeTestConfig(configDir, { localPlugins: [], tools: {} });

      // Wait for config watcher reload, then confirm via POST /reload
      await waitForLog(server, 'Config reload complete: 0 plugin', 10_000);
      await postReload(server.port, configDir);

      // Verify the no-plugins card appears
      await expect(sidePanelPage.locator('text=No Plugins Installed')).toBeVisible({ timeout: 30_000 });

      await sidePanelPage.close();
    } finally {
      await context?.close();
      await server?.kill();
      if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });
});
