/**
 * Side panel error states E2E tests.
 *
 * Verifies:
 *   1. Failed plugin cards render with "Failed to load" header, specifier, and error message
 *   2. Long error messages (>100 chars) show a "Show more"/"Show less" toggle
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupTestConfigDir,
  expect,
  launchExtensionContext,
  startMcpServer,
  test,
  writeTestConfig,
} from './fixtures.js';
import { openSidePanel, setupAdapterSymlink, waitForExtensionConnected } from './helpers.js';

test.describe('Side panel error states', () => {
  test('broken plugin shows FailedPluginCard with specifier and error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-broken-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-config-'));

    // Create a broken plugin — valid package.json with opentabs field but no dist/ artifacts
    const brokenDir = path.join(tmpDir, 'broken-plugin');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenDir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-broken',
        version: '1.0.0',
        opentabs: { name: 'broken' },
      }),
    );

    const brokenPath = path.resolve(brokenDir);
    writeTestConfig(configDir, { localPlugins: [brokenPath] });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      const sidePanel = await openSidePanel(context);

      // FailedPluginCard renders with "Failed to load" header
      await expect(sidePanel.getByText('Failed to load')).toBeVisible({ timeout: 15_000 });

      // The plugin specifier (the local path) is displayed
      await expect(sidePanel.getByText(brokenPath)).toBeVisible();

      // The error card container is rendered with destructive styling
      const errorCard = sidePanel.locator('.bg-destructive\\/10');
      await expect(errorCard).toBeVisible();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  });

  test('long error shows Show more/less toggle', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-broken-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-config-'));

    // Use a long directory name to guarantee the error message exceeds 100 chars.
    // The loader produces: "Failed to read dist/tools.json at <path>: file missing or invalid JSON"
    const longName =
      'broken-plugin-with-a-deliberately-very-long-directory-name-to-ensure-error-exceeds-one-hundred-chars';
    const brokenDir = path.join(tmpDir, longName);
    fs.mkdirSync(path.join(brokenDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(brokenDir, 'package.json'),
      JSON.stringify({
        name: `opentabs-plugin-${longName}`,
        version: '1.0.0',
        opentabs: { name: longName },
      }),
    );
    // Valid adapter but invalid tools.json triggers a long error message
    fs.writeFileSync(path.join(brokenDir, 'dist', 'adapter.iife.js'), '(function(){})();');
    fs.writeFileSync(path.join(brokenDir, 'dist', 'tools.json'), '{invalid json}');

    const brokenPath = path.resolve(brokenDir);
    writeTestConfig(configDir, { localPlugins: [brokenPath] });

    const server = await startMcpServer(configDir, true);
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port, server.secret);
    setupAdapterSymlink(configDir, extensionDir);

    try {
      await waitForExtensionConnected(server);
      const sidePanel = await openSidePanel(context);

      // Wait for the FailedPluginCard
      await expect(sidePanel.getByText('Failed to load')).toBeVisible({ timeout: 15_000 });

      // "Show more" button appears for long errors (>100 chars)
      await expect(sidePanel.getByText('Show more')).toBeVisible();

      // Click "Show more" to expand — button changes to "Show less"
      await sidePanel.getByText('Show more').click();
      await expect(sidePanel.getByText('Show less')).toBeVisible();

      // Click "Show less" to collapse — button changes back to "Show more"
      await sidePanel.getByText('Show less').click();
      await expect(sidePanel.getByText('Show more')).toBeVisible();
    } finally {
      await context.close().catch(() => {});
      await server.kill();
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  });
});
