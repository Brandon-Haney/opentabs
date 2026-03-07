/**
 * Side panel open tab E2E tests — verify the plugin icon click behavior:
 *
 * 1. Clicking the icon focuses a matching tab
 * 2. Repeated clicks cycle through multiple matching tabs (round-robin)
 * 3. Tooltip shows the correct tab count
 * 4. Icon is disabled when no tabs exist and no homepage
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupTestConfigDir,
  E2E_TEST_PLUGIN_DIR,
  expect,
  launchExtensionContext,
  readPluginToolNames,
  startMcpServer,
  startTestServer,
  test,
  writeTestConfig,
} from './fixtures.js';
import { openSidePanel, setupAdapterSymlink, waitForExtensionConnected, waitForLog } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll the MCP server /health until the e2e-test plugin reaches the expected tab state. */
const waitForPluginTabState = async (
  server: { port: number; secret: string | undefined },
  expected: string,
  timeoutMs = 30_000,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        try {
          const res = await fetch(`http://localhost:${server.port}/health`, {
            headers: { Authorization: `Bearer ${server.secret ?? ''}` },
            signal: AbortSignal.timeout(3_000),
          });
          const body = (await res.json()) as {
            pluginDetails?: Array<{ name: string; tabState: string }>;
          };
          return body.pluginDetails?.find(p => p.name === 'e2e-test')?.tabState;
        } catch {
          return undefined;
        }
      },
      {
        timeout: timeoutMs,
        message: `Server tab state for e2e-test did not become '${expected}'`,
      },
    )
    .toBe(expected);
};

// ---------------------------------------------------------------------------
// US-005: Open tab feature — focus and cycle
// ---------------------------------------------------------------------------

test.describe('Side panel open tab', () => {
  test('clicking plugin icon focuses the matching tab', async () => {
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-opentab-focus-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const testServer = await startTestServer();
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'tab.syncAll received', 15_000);

      // Open a matching tab
      const appTab = await context.newPage();
      await appTab.goto(testServer.url, { waitUntil: 'load' });

      // Wait for ready state
      await waitForPluginTabState(server, 'ready');

      // Open side panel and reload to pick up tab state
      const sidePanelPage = await openSidePanel(context);
      await sidePanelPage.reload({ waitUntil: 'load' });
      await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      // Find the icon button by aria-label (tooltip text for ready state with 1 tab)
      const iconButton = sidePanelPage.locator('button[aria-label="Open E2E Test"]');
      await expect(iconButton).toBeVisible({ timeout: 5_000 });
      await expect(iconButton).toBeEnabled();

      // Bring the side panel to front (it may already be active)
      await sidePanelPage.bringToFront();

      // Click the icon — it should focus the matching tab
      await iconButton.click();

      // Verify the app tab became the active page. In Playwright, the page
      // that received focus gets a 'focus' event. We verify by checking that
      // the app tab's URL is still the test server URL (it wasn't closed).
      // Since Playwright BrowserContext doesn't have a direct "active tab" API,
      // we verify by bringing the side panel to front again and checking that
      // the app tab was focused via the round-trip.
      // A more reliable check: verify the appTab page received focus.
      await expect
        .poll(() => appTab.evaluate(() => document.hasFocus()), {
          timeout: 5_000,
          message: 'App tab did not receive focus after clicking the icon',
        })
        .toBe(true);

      await sidePanelPage.close();
      await appTab.close();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      await testServer.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('clicking plugin icon cycles through multiple tabs', async () => {
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-opentab-cycle-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const testServer = await startTestServer();
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'tab.syncAll received', 15_000);

      // Open two matching tabs
      const appTab1 = await context.newPage();
      await appTab1.goto(testServer.url, { waitUntil: 'load' });

      await waitForPluginTabState(server, 'ready');

      const appTab2 = await context.newPage();
      await appTab2.goto(testServer.url, { waitUntil: 'load' });

      // Wait for the server to report both tabs (ready state is maintained with 2 tabs)
      // Poll /health until we see 2 tabs in the plugin details
      await expect
        .poll(
          async () => {
            try {
              const res = await fetch(`http://localhost:${server.port}/health`, {
                headers: { Authorization: `Bearer ${server.secret ?? ''}` },
                signal: AbortSignal.timeout(3_000),
              });
              const body = (await res.json()) as {
                pluginDetails?: Array<{ name: string; tabs?: Array<{ tabId: number }> }>;
              };
              return body.pluginDetails?.find(p => p.name === 'e2e-test')?.tabs?.length ?? 0;
            } catch {
              return 0;
            }
          },
          {
            timeout: 30_000,
            message: 'Server did not report 2 tabs for e2e-test plugin',
          },
        )
        .toBeGreaterThanOrEqual(2);

      // Open side panel and reload to pick up tab state
      const sidePanelPage = await openSidePanel(context);
      await sidePanelPage.reload({ waitUntil: 'load' });
      await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      // The tooltip should show the tab count for 2 tabs
      const iconButton = sidePanelPage.locator('button[aria-label="Open E2E Test (2 tabs)"]');
      await expect(iconButton).toBeVisible({ timeout: 5_000 });

      // First click — focuses one tab
      await sidePanelPage.bringToFront();
      await iconButton.click();

      // Determine which tab got focus
      const tab1Focused = await appTab1.evaluate(() => document.hasFocus()).catch(() => false);
      const tab2Focused = await appTab2.evaluate(() => document.hasFocus()).catch(() => false);
      expect(tab1Focused || tab2Focused).toBe(true);

      const firstFocusedTab = tab1Focused ? appTab1 : appTab2;
      const otherTab = tab1Focused ? appTab2 : appTab1;

      // Second click — should cycle to the other tab
      await sidePanelPage.bringToFront();
      await iconButton.click();

      await expect
        .poll(() => otherTab.evaluate(() => document.hasFocus()).catch(() => false), {
          timeout: 5_000,
          message: 'Second click did not cycle to the other tab',
        })
        .toBe(true);

      // Third click — should cycle back to the first tab
      await sidePanelPage.bringToFront();
      await iconButton.click();

      await expect
        .poll(() => firstFocusedTab.evaluate(() => document.hasFocus()).catch(() => false), {
          timeout: 5_000,
          message: 'Third click did not cycle back to the first tab',
        })
        .toBe(true);

      await sidePanelPage.close();
      await appTab1.close();
      await appTab2.close();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      await testServer.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('icon shows correct tooltip with tab count', async () => {
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-opentab-tooltip-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const testServer = await startTestServer();
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'tab.syncAll received', 15_000);

      // Open side panel with no matching tabs (closed state, no homepage)
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      // When closed and no homepage, the tooltip shows the version.
      // The e2e-test plugin has no homepage, so the icon should show version text.
      const versionButton = sidePanelPage.locator('button[aria-label^="v0.0."]');
      await expect(versionButton).toBeVisible({ timeout: 5_000 });

      // Open one matching tab
      const appTab1 = await context.newPage();
      await appTab1.goto(testServer.url, { waitUntil: 'load' });
      await waitForPluginTabState(server, 'ready');

      // Reload side panel to pick up updated state
      await sidePanelPage.reload({ waitUntil: 'load' });
      await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 15_000 });

      // With 1 tab, tooltip should be "Open E2E Test" (no count)
      const singleTabButton = sidePanelPage.locator('button[aria-label="Open E2E Test"]');
      await expect(singleTabButton).toBeVisible({ timeout: 5_000 });

      // Open a second matching tab
      const appTab2 = await context.newPage();
      await appTab2.goto(testServer.url, { waitUntil: 'load' });

      // Wait for 2 tabs to be reported
      await expect
        .poll(
          async () => {
            try {
              const res = await fetch(`http://localhost:${server.port}/health`, {
                headers: { Authorization: `Bearer ${server.secret ?? ''}` },
                signal: AbortSignal.timeout(3_000),
              });
              const body = (await res.json()) as {
                pluginDetails?: Array<{ name: string; tabs?: Array<{ tabId: number }> }>;
              };
              return body.pluginDetails?.find(p => p.name === 'e2e-test')?.tabs?.length ?? 0;
            } catch {
              return 0;
            }
          },
          { timeout: 30_000, message: 'Server did not report 2 tabs' },
        )
        .toBeGreaterThanOrEqual(2);

      // Reload side panel
      await sidePanelPage.reload({ waitUntil: 'load' });
      await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 15_000 });

      // With 2 tabs, tooltip should show count
      const multiTabButton = sidePanelPage.locator('button[aria-label="Open E2E Test (2 tabs)"]');
      await expect(multiTabButton).toBeVisible({ timeout: 5_000 });

      await sidePanelPage.close();
      await appTab1.close();
      await appTab2.close();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      await testServer.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('icon not clickable when no tabs and no homepage', async () => {
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-opentab-disabled-'));
    writeTestConfig(configDir, { localPlugins: [absPluginPath], tools });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      await waitForLog(server, 'tab.syncAll received', 15_000);

      // Open side panel with no matching tabs
      const sidePanelPage = await openSidePanel(context);
      await expect(sidePanelPage.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      // The e2e-test plugin has no homepage, so in closed state the icon
      // button should be disabled. The aria-label is the version string.
      const iconButton = sidePanelPage.locator('button[aria-label^="v0.0."]');
      await expect(iconButton).toBeVisible({ timeout: 5_000 });
      await expect(iconButton).toBeDisabled();

      // Verify no cursor-pointer class on the disabled button
      const hasPointer = await iconButton.evaluate(el => el.classList.contains('cursor-pointer'));
      expect(hasPointer).toBe(false);

      await sidePanelPage.close();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });
});
