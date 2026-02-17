/**
 * Side panel data flow E2E tests — verify the three data paths:
 *
 * 1. Connection status: side panel reflects WebSocket connect/disconnect
 * 2. Tab state changes: direct push from background → side panel
 * 3. Tool invocation animation: spinner appears during tool execution
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
import { waitForExtensionConnected, waitForLog } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the extension ID from the background service worker URL.
 * The service worker URL follows the pattern: chrome-extension://<id>/dist/background.js
 */
const getExtensionId = async (context: BrowserContext): Promise<string> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const sw of context.serviceWorkers()) {
      const m = sw.url().match(/chrome-extension:\/\/([^/]+)/);
      if (m?.[1]) return m[1];
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Could not find extension service worker within 10s');
};

/**
 * Open the side panel as a regular extension page in the browser context.
 */
const openSidePanel = async (context: BrowserContext): Promise<Page> => {
  const extId = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/side-panel/side-panel.html`, {
    waitUntil: 'load',
    timeout: 10_000,
  });
  return page;
};

/**
 * Set up the adapter symlink between the MCP server's config dir and the
 * extension's adapters directory.
 */
const setupAdapterSymlink = (configDir: string, extensionDir: string): void => {
  const serverAdaptersParent = path.join(configDir, 'extension');
  fs.mkdirSync(serverAdaptersParent, { recursive: true });
  const serverAdaptersDir = path.join(serverAdaptersParent, 'adapters');
  const extensionAdaptersDir = path.join(extensionDir, 'adapters');
  fs.mkdirSync(extensionAdaptersDir, { recursive: true });
  fs.rmSync(serverAdaptersDir, { recursive: true, force: true });
  fs.symlinkSync(extensionAdaptersDir, serverAdaptersDir);
};

// ---------------------------------------------------------------------------
// US-003: Connection status tests
// ---------------------------------------------------------------------------

test.describe('Side panel data flow — connection status', () => {
  test('shows connected status and transitions on server stop/restart', async () => {
    // 1. Start MCP server with e2e-test plugin
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-conn-'));
    writeTestConfig(configDir, { plugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const serverPort = server.port;
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      // 2. Wait for extension to connect
      await waitForExtensionConnected(server);
      await waitForLog(server, 'Config watcher: Watching', 10_000);

      // 3. Open side panel
      const sidePanelPage = await openSidePanel(context);

      // 4. Verify 'Connected' text visible (exact match to avoid matching 'Disconnected')
      await expect(sidePanelPage.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10_000 });

      // 5. Verify plugin card visible
      await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      // 6. Kill MCP server
      await server.kill();

      // 7. Verify 'Disconnected' text appears
      // The offscreen document detects WebSocket close and broadcasts connection state.
      // Pong timeout is 5s + reconnect backoff, so allow up to 30s.
      await expect(sidePanelPage.getByText('Disconnected', { exact: true })).toBeVisible({ timeout: 30_000 });

      // 8. Verify plugin list is cleared (no plugin cards visible)
      await expect(sidePanelPage.getByText('MCP server not connected')).toBeVisible({ timeout: 10_000 });

      // 9. Restart MCP server on the same port
      const server2 = await startMcpServer(configDir, true, serverPort);

      try {
        // 10. Verify 'Connected' text reappears
        // The offscreen document's reconnect logic will find the new server.
        await expect(sidePanelPage.getByText('Connected', { exact: true })).toBeVisible({ timeout: 45_000 });

        // 11. Verify plugin card reappears
        await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });
      } finally {
        await server2.kill();
      }

      await sidePanelPage.close();
    } finally {
      await context.close();
      // server.kill() is safe to call multiple times
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });
});
