/**
 * Side panel search interaction detail E2E tests — verify filtering behavior,
 * empty states, and clear button for the search bar in the side panel.
 *
 * These tests exercise the SearchResults component via the live extension
 * by typing into the search input and asserting on the filtered plugin list.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupTestConfigDir,
  E2E_TEST_PLUGIN_DIR,
  expect,
  launchExtensionContext,
  startMcpServer,
  test,
  writeTestConfig,
} from './fixtures.js';
import { openSidePanel, setupAdapterSymlink, waitForExtensionConnected } from './helpers.js';

test.describe('Side panel search details', () => {
  test('no results empty state when search matches nothing', async () => {
    test.slow();

    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-no-results-'));
    writeTestConfig(configDir, {
      localPlugins: [absPluginPath],
      permissions: {
        'e2e-test': { permission: 'auto' },
        browser: { permission: 'auto' },
      },
    });

    const server = await startMcpServer(configDir, false);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);

      const sidePanel = await openSidePanel(context);

      // Wait for plugins to load
      await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      const searchInput = sidePanel.getByPlaceholder('Search plugins and tools...');

      // Type a nonsense string that matches no installed plugins and no npm results
      await searchInput.fill('xyzzy99nonexistent');

      // Wait for npm search to complete and 'No plugins found' to appear
      await expect(sidePanel.getByText('No plugins found')).toBeVisible({ timeout: 15_000 });

      // No section headers should be shown
      await expect(sidePanel.getByText('Installed')).toBeHidden();
      await expect(sidePanel.getByText('Available')).toBeHidden();

      await sidePanel.close();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('search filters installed plugins by tool name and shows Installed header', async () => {
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-search-filter-'));
    writeTestConfig(configDir, {
      localPlugins: [absPluginPath],
      permissions: {
        'e2e-test': { permission: 'auto' },
        browser: { permission: 'auto' },
      },
    });

    const server = await startMcpServer(configDir, false);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);

      const sidePanel = await openSidePanel(context);

      // Wait for the e2e-test plugin to appear in the default list
      await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      const searchInput = sidePanel.getByPlaceholder('Search plugins and tools...');

      // Type 'echo' — a tool name in the e2e-test plugin
      await searchInput.fill('echo');

      // The 'Installed' section header should appear
      await expect(sidePanel.getByText('Installed')).toBeVisible();

      // The e2e-test plugin card should still be visible (it matched)
      await expect(sidePanel.getByText('E2E Test')).toBeVisible();

      // Clear the search
      await searchInput.fill('');

      // The 'Installed' section header should disappear (default view has no section headers)
      await expect(sidePanel.getByText('Installed')).toBeHidden();

      // All plugins should be visible again — e2e-test plugin still shows
      await expect(sidePanel.getByText('E2E Test')).toBeVisible();

      await sidePanel.close();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('search clear button (X) clears the search and returns to default view', async () => {
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-sp-clear-btn-'));
    writeTestConfig(configDir, {
      localPlugins: [absPluginPath],
      permissions: {
        'e2e-test': { permission: 'auto' },
        browser: { permission: 'auto' },
      },
    });

    const server = await startMcpServer(configDir, false);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);

      const sidePanel = await openSidePanel(context);

      // Wait for plugins to load
      await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

      const searchInput = sidePanel.getByPlaceholder('Search plugins and tools...');

      // Type a search query
      await searchInput.fill('echo');

      // The 'Installed' section header should appear (search results mode)
      await expect(sidePanel.getByText('Installed')).toBeVisible();

      // The clear button should be visible
      const clearBtn = sidePanel.getByLabel('Clear search');
      await expect(clearBtn).toBeVisible();

      // Click the clear button
      await clearBtn.click();

      // Search bar should be empty
      await expect(searchInput).toHaveValue('');

      // Clear button should be hidden (only visible when search has text)
      await expect(clearBtn).toBeHidden();

      // Default view restored — no section headers
      await expect(sidePanel.getByText('Installed')).toBeHidden();

      // All plugins should be visible again
      await expect(sidePanel.getByText('E2E Test')).toBeVisible();

      await sidePanel.close();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });
});
