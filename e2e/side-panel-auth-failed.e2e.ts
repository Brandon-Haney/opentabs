/**
 * Side panel auth-failed E2E test — verifies the side panel shows the
 * "Authentication Failed" empty state when the extension connects with
 * a wrong secret.
 *
 * Uses manual setup (not the standard extensionContext fixture) because
 * it needs to launch the extension with a deliberately mismatched secret.
 */

import {
  test,
  expect,
  startMcpServer,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchExtensionContext,
} from './fixtures.js';
import { openSidePanel } from './helpers.js';
import fs from 'node:fs';
import type { McpServer } from './fixtures.js';

test.describe('Side panel auth failed', () => {
  test('shows Authentication Failed when extension has wrong secret', async () => {
    const configDir = createTestConfigDir();
    let server: McpServer | null = null;
    let cleanupDir: string | null = null;

    try {
      server = await startMcpServer(configDir, true);

      // Launch extension with a WRONG secret — does not match the server's secret
      const { context, cleanupDir: extCleanupDir } = await launchExtensionContext(server.port, 'wrong-secret-value');
      cleanupDir = extCleanupDir;

      try {
        // Open the side panel and wait for "Authentication Failed" to appear.
        // This is the polling wait — the side panel only shows this state after
        // the extension has actually attempted /ws-info and received a 401
        // rejection. Waiting here is both faster and more reliable than a
        // fixed sleep.
        const sidePanelPage = await openSidePanel(context);
        await expect(sidePanelPage.getByText('Authentication Failed')).toBeVisible({ timeout: 15_000 });

        // Verify the extension is NOT connected (meaningful now — auth rejection confirmed)
        const health = await server.health();
        expect(health).not.toBeNull();
        if (!health) throw new Error('health returned null');
        expect(health.extensionConnected).toBe(false);

        // It should NOT show the other disconnect states
        await expect(sidePanelPage.getByText('Cannot Reach MCP Server')).not.toBeVisible();
        await expect(sidePanelPage.getByText('No Plugins Installed')).not.toBeVisible();

        // Verify /health still shows extension disconnected
        const health2 = await server.health();
        expect(health2).not.toBeNull();
        if (!health2) throw new Error('health returned null');
        expect(health2.extensionConnected).toBe(false);

        await sidePanelPage.close();
      } finally {
        await context.close();
      }
    } finally {
      if (server) await server.kill();
      cleanupTestConfigDir(configDir);
      if (cleanupDir) {
        try {
          fs.rmSync(cleanupDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });
});
