/**
 * Plugin review system E2E tests — verifies the full review flow end-to-end:
 *
 *   - Agent calls a tool on an 'off' plugin → receives error with review instructions
 *   - plugin_inspect returns adapter source code, metadata, and review token
 *   - plugin_mark_reviewed with valid token sets permission and reviewedVersion
 *   - plugin_mark_reviewed with invalid/used token returns error
 *   - Plugin version change resets permission to 'off'
 *   - Side panel shows unreviewed icon for unreviewed plugins
 *   - Side panel shows confirmation dialog when enabling unreviewed plugin
 *   - Reviewed plugin does not show unreviewed icon or dialog
 *   - plugin_inspect and plugin_mark_reviewed do not appear in side panel
 *
 * These tests start the MCP server WITHOUT OPENTABS_DANGEROUSLY_SKIP_PERMISSIONS and use
 * explicit plugin permission configs to exercise the review system.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import type { McpClient, McpServer, TestServer } from './fixtures.js';
import {
  cleanupTestConfigDir,
  createMcpClient,
  createTestConfigDir,
  E2E_TEST_PLUGIN_DIR,
  launchExtensionContext,
  readTestConfig,
  startMcpServer,
  startTestServer,
  symlinkCrossPlatform,
  writeTestConfig,
} from './fixtures.js';
import {
  openSidePanel,
  openTestAppTab,
  setupAdapterSymlink,
  waitForExtensionConnected,
  waitForLog,
  waitForToolList,
  waitForToolResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Custom fixture — MCP server without skipPermissions
// ---------------------------------------------------------------------------

interface ReviewFixtures {
  /** MCP server started WITHOUT OPENTABS_DANGEROUSLY_SKIP_PERMISSIONS. */
  mcpServer: McpServer;
  /** Controllable test web server. */
  testServer: TestServer;
  /** Chromium browser context with the extension loaded. */
  extensionContext: BrowserContext;
  /** MCP client pointed at this test's server. */
  mcpClient: McpClient;
}

const test = base.extend<ReviewFixtures>({
  mcpServer: async ({ browserName: _ }, use) => {
    const configDir = createTestConfigDir();
    // Override: all plugins default to 'off' (no permissions entries) for review testing
    writeTestConfig(configDir, {
      localPlugins: [path.resolve(E2E_TEST_PLUGIN_DIR)],
      permissions: {},
    });
    const server = await startMcpServer(configDir, true, undefined, {
      OPENTABS_DANGEROUSLY_SKIP_PERMISSIONS: '',
    });
    try {
      await use(server);
    } finally {
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  },

  testServer: async ({ browserName: _ }, use) => {
    const srv = await startTestServer();
    try {
      await use(srv);
    } finally {
      await srv.kill();
    }
  },

  extensionContext: async ({ mcpServer }, use) => {
    const { context, cleanupDir, extensionDir } = await launchExtensionContext(mcpServer.port, mcpServer.secret);
    setupAdapterSymlink(mcpServer.configDir, extensionDir);

    const serverAuthJson = path.join(mcpServer.configDir, 'extension', 'auth.json');
    const extensionAuthJson = path.join(extensionDir, 'auth.json');
    fs.rmSync(extensionAuthJson, { force: true });
    symlinkCrossPlatform(serverAuthJson, extensionAuthJson, 'file');

    await use(context);
    await context.close();
    try {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  },

  mcpClient: async ({ mcpServer }, use) => {
    const client = createMcpClient(mcpServer.port, mcpServer.secret);
    await client.initialize();
    await use(client);
    await client.close();
  },
});

// ---------------------------------------------------------------------------
// Radix Select helper
// ---------------------------------------------------------------------------

/** Click a Radix Select trigger (by aria-label) and choose an option by display text. */
const selectPermission = async (page: Page, ariaLabel: string, optionText: string) => {
  await page.locator(`[aria-label="${ariaLabel}"]`).click();
  await page.locator('[role="option"]', { hasText: optionText }).click();
};

// ---------------------------------------------------------------------------
// Helper: wait for unreviewed dialog in the side panel
// ---------------------------------------------------------------------------

const waitForUnreviewedDialog = async (sidePanel: Page, timeoutMs = 15_000): Promise<void> => {
  await sidePanel.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: timeoutMs });
};

// ---------------------------------------------------------------------------
// Helper: read the e2e-test plugin version from package.json
// ---------------------------------------------------------------------------

const getE2eTestPluginVersion = (): string => {
  const pkgPath = path.join(E2E_TEST_PLUGIN_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
};

// ---------------------------------------------------------------------------
// Tests — Full review flow (inspect → mark reviewed → tool succeeds)
// ---------------------------------------------------------------------------

test.describe('Plugin review flow — full cycle', () => {
  test('agent calls off tool → gets review instructions → inspects → marks reviewed → tool succeeds', async ({
    mcpServer,
    extensionContext,
    testServer,
    mcpClient,
  }) => {
    await waitForExtensionConnected(mcpServer);
    await waitForLog(mcpServer, 'tab.syncAll received');

    // Open a matching tab so the e2e-test plugin becomes ready.
    // The plugin has no permission config (defaults to 'off'), so we wait for
    // the tab state rather than a tool result.
    await openTestAppTab(extensionContext, testServer.url, mcpServer, testServer);

    // Step 1: Call a tool on the unreviewed 'off' plugin — should get review instructions
    const offResult = await mcpClient.callTool('e2e-test_echo', { message: 'hello' });
    expect(offResult.isError).toBe(true);
    expect(offResult.content).toContain('has not been reviewed yet');
    expect(offResult.content).toContain('plugin_inspect');
    expect(offResult.content).toContain('plugin_mark_reviewed');

    // Step 2: Call plugin_inspect to get source code and review token
    const inspectResult = await mcpClient.callTool('plugin_inspect', { plugin: 'e2e-test' });
    expect(inspectResult.isError).toBe(false);

    const inspectData = JSON.parse(inspectResult.content) as {
      plugin: string;
      version: string;
      lineCount: number;
      byteSize: number;
      reviewToken: string;
      reviewGuidance: string;
      adapterSource: string;
    };

    expect(inspectData.plugin).toBe('e2e-test');
    expect(inspectData.version).toBe(getE2eTestPluginVersion());
    expect(inspectData.lineCount).toBeGreaterThan(0);
    expect(inspectData.byteSize).toBeGreaterThan(0);
    expect(inspectData.reviewToken).toBeTruthy();
    expect(inspectData.reviewGuidance).toContain('Data exfiltration');
    expect(inspectData.adapterSource).toContain('e2e-test');

    // Step 3: Call plugin_mark_reviewed with the token to set permission to 'auto'
    const markResult = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'e2e-test',
      version: inspectData.version,
      reviewToken: inspectData.reviewToken,
      permission: 'auto',
    });
    expect(markResult.isError).toBe(false);
    expect(markResult.content).toContain('has been reviewed');
    expect(markResult.content).toContain('permission set to "auto"');

    // Step 4: Retry the original tool — should now succeed (permission is 'auto')
    const retryResult = await waitForToolResult(mcpClient, 'e2e-test_echo', { message: 'hello' }, { isError: false });
    expect(retryResult.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — plugin_inspect
// ---------------------------------------------------------------------------

test.describe('plugin_inspect', () => {
  test('returns error for unknown plugin', async ({ mcpClient }) => {
    const result = await mcpClient.callTool('plugin_inspect', { plugin: 'nonexistent-plugin' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('returns source code and review token for valid plugin', async ({ mcpClient }) => {
    const result = await mcpClient.callTool('plugin_inspect', { plugin: 'e2e-test' });
    expect(result.isError).toBe(false);

    const data = JSON.parse(result.content) as {
      plugin: string;
      version: string;
      reviewToken: string;
      adapterSource: string;
      reviewGuidance: string;
    };

    expect(data.plugin).toBe('e2e-test');
    expect(data.version).toBeTruthy();
    expect(data.reviewToken).toBeTruthy();
    expect(data.adapterSource.length).toBeGreaterThan(100);
    expect(data.reviewGuidance).toContain('How to report');
  });
});

// ---------------------------------------------------------------------------
// Tests — plugin_mark_reviewed token validation
// ---------------------------------------------------------------------------

test.describe('plugin_mark_reviewed — token validation', () => {
  test('fails with invalid (fabricated) token', async ({ mcpClient }) => {
    const result = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'e2e-test',
      version: getE2eTestPluginVersion(),
      reviewToken: 'fabricated-invalid-token-12345',
      permission: 'auto',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid or expired review token');
  });

  test('fails without calling plugin_inspect first (no valid token)', async ({ mcpClient }) => {
    const result = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'e2e-test',
      version: getE2eTestPluginVersion(),
      reviewToken: '00000000-0000-0000-0000-000000000000',
      permission: 'auto',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid or expired review token');
  });

  test('fails when token is reused (already consumed)', async ({ mcpClient }) => {
    // Get a valid token via plugin_inspect
    const inspectResult = await mcpClient.callTool('plugin_inspect', { plugin: 'e2e-test' });
    expect(inspectResult.isError).toBe(false);
    const { reviewToken, version } = JSON.parse(inspectResult.content) as {
      reviewToken: string;
      version: string;
    };

    // First use — should succeed
    const firstMark = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'e2e-test',
      version,
      reviewToken,
      permission: 'auto',
    });
    expect(firstMark.isError).toBe(false);

    // Second use — same token, should fail
    const secondMark = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'e2e-test',
      version,
      reviewToken,
      permission: 'auto',
    });
    expect(secondMark.isError).toBe(true);
    expect(secondMark.content).toContain('Invalid or expired review token');
  });

  test('fails with wrong plugin name', async ({ mcpClient }) => {
    // Get token for e2e-test plugin
    const inspectResult = await mcpClient.callTool('plugin_inspect', { plugin: 'e2e-test' });
    expect(inspectResult.isError).toBe(false);
    const { reviewToken, version } = JSON.parse(inspectResult.content) as {
      reviewToken: string;
      version: string;
    };

    // Try to use it for a different plugin
    const result = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'nonexistent',
      version,
      reviewToken,
      permission: 'auto',
    });
    expect(result.isError).toBe(true);
  });

  test('fails with wrong version', async ({ mcpClient }) => {
    const inspectResult = await mcpClient.callTool('plugin_inspect', { plugin: 'e2e-test' });
    expect(inspectResult.isError).toBe(false);
    const { reviewToken } = JSON.parse(inspectResult.content) as { reviewToken: string };

    const result = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'e2e-test',
      version: '99.99.99',
      reviewToken,
      permission: 'auto',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid or expired review token');
  });

  test('rejects permission "off"', async ({ mcpClient }) => {
    const inspectResult = await mcpClient.callTool('plugin_inspect', { plugin: 'e2e-test' });
    expect(inspectResult.isError).toBe(false);
    const { reviewToken, version } = JSON.parse(inspectResult.content) as {
      reviewToken: string;
      version: string;
    };

    const result = await mcpClient.callTool('plugin_mark_reviewed', {
      plugin: 'e2e-test',
      version,
      reviewToken,
      permission: 'off',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"permission" must be "ask" or "auto"');
  });
});

// ---------------------------------------------------------------------------
// Tests — Version reset on plugin update
// ---------------------------------------------------------------------------

test.describe('Plugin version change resets permission', () => {
  test('permission resets to off when plugin version changes after hot reload', async ({ mcpServer, mcpClient }) => {
    const pluginVersion = getE2eTestPluginVersion();

    // Set up the plugin as reviewed with 'auto' permission
    const config = readTestConfig(mcpServer.configDir);
    config.permissions = {
      'e2e-test': {
        permission: 'auto',
        reviewedVersion: pluginVersion,
      },
    };
    writeTestConfig(mcpServer.configDir, config);

    mcpServer.logs.length = 0;
    mcpServer.triggerHotReload();
    await waitForLog(mcpServer, 'Hot reload complete', 20_000);

    // Verify the plugin is currently auto (tools have no [Disabled] prefix)
    await waitForToolList(
      mcpClient,
      tools => {
        const echo = tools.find(t => t.name === 'e2e-test_echo');
        return echo !== undefined && !echo.description.startsWith('[Disabled]');
      },
      15_000,
      300,
      'e2e-test_echo should not have [Disabled] prefix',
    );

    // Now simulate a version change by setting a mismatched reviewedVersion
    const config2 = readTestConfig(mcpServer.configDir);
    config2.permissions = {
      'e2e-test': {
        permission: 'auto',
        reviewedVersion: '0.0.0-old',
      },
    };
    writeTestConfig(mcpServer.configDir, config2);

    mcpServer.logs.length = 0;
    mcpServer.triggerHotReload();
    await waitForLog(mcpServer, 'Hot reload complete', 20_000);

    // After reload, the version mismatch causes reset to 'off' and reviewedVersion is cleared
    await waitForToolList(
      mcpClient,
      tools => {
        const echo = tools.find(t => t.name === 'e2e-test_echo');
        return echo?.description?.startsWith('[Disabled]') ?? false;
      },
      15_000,
      300,
      'e2e-test_echo should have [Disabled] prefix after version reset',
    );

    // Server should have logged the version reset
    expect(mcpServer.logs.join('\n')).toContain('resetting permission');

    // Calling the tool should return the review error (reviewedVersion was cleared
    // by resetStaleReviewedVersions, so the message says "not been reviewed yet")
    const result = await mcpClient.callTool('e2e-test_echo', { message: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('has not been reviewed yet');
  });
});

// ---------------------------------------------------------------------------
// Tests — Side panel: unreviewed icon
// ---------------------------------------------------------------------------

test.describe('Side panel — unreviewed icon', () => {
  test('unreviewed plugin shows ShieldQuestionMark icon', async ({ mcpServer, extensionContext }) => {
    // Plugin has no reviewedVersion → it is unreviewed
    await waitForExtensionConnected(mcpServer);
    await waitForLog(mcpServer, 'tab.syncAll received');

    const sidePanel = await openSidePanel(extensionContext);
    await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

    // The ShieldQuestionMark icon should be visible in the plugin card header
    const pluginCard = sidePanel.locator('button[aria-expanded]').filter({ hasText: 'E2E Test' });
    const shieldIcon = pluginCard.locator('svg.lucide-shield-question-mark');
    await expect(shieldIcon).toBeVisible({ timeout: 5_000 });

    await sidePanel.close();
  });

  test('reviewed plugin does not show ShieldQuestionMark icon', async ({ mcpServer, extensionContext }) => {
    const pluginVersion = getE2eTestPluginVersion();

    // Set the plugin as reviewed
    const config = readTestConfig(mcpServer.configDir);
    config.permissions = {
      'e2e-test': {
        permission: 'auto',
        reviewedVersion: pluginVersion,
      },
    };
    writeTestConfig(mcpServer.configDir, config);

    mcpServer.logs.length = 0;
    mcpServer.triggerHotReload();
    await waitForLog(mcpServer, 'Hot reload complete', 20_000);

    await waitForExtensionConnected(mcpServer);
    await waitForLog(mcpServer, 'tab.syncAll received');

    const sidePanel = await openSidePanel(extensionContext);
    await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

    // The ShieldQuestionMark icon should NOT be visible for a reviewed plugin
    const pluginCard = sidePanel.locator('button[aria-expanded]').filter({ hasText: 'E2E Test' });
    const shieldIcon = pluginCard.locator('svg.lucide-shield-question-mark');
    await expect(shieldIcon).toBeHidden({ timeout: 5_000 });

    await sidePanel.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — Side panel: unreviewed plugin confirmation dialog
// ---------------------------------------------------------------------------

test.describe('Side panel — unreviewed plugin confirmation dialog', () => {
  test('dialog appears when enabling unreviewed plugin, "Enable Anyway" sets permission and reviewedVersion', async ({
    mcpServer,
    extensionContext,
    mcpClient,
  }) => {
    await waitForExtensionConnected(mcpServer);
    await waitForLog(mcpServer, 'tab.syncAll received');

    const sidePanel = await openSidePanel(extensionContext);
    await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

    // Change the plugin permission from 'off' to 'auto' — should trigger the dialog
    const pluginTrigger = sidePanel.locator('[aria-label="Permission for e2e-test plugin"]');
    await expect(pluginTrigger).toBeVisible({ timeout: 5_000 });
    await selectPermission(sidePanel, 'Permission for e2e-test plugin', 'Auto');

    // Dialog should appear
    await waitForUnreviewedDialog(sidePanel);
    const dialog = sidePanel.locator('[role="dialog"]');
    await expect(dialog.getByText('Unreviewed Plugin')).toBeVisible();
    await expect(dialog.getByText('has not been reviewed')).toBeVisible();

    // Click "Enable Anyway"
    await dialog.getByRole('button', { name: 'Enable Anyway' }).click();

    // Dialog should close
    await expect(sidePanel.locator('[role="dialog"]')).toBeHidden({ timeout: 5_000 });

    // Wait for the MCP server to reflect the permission change (no more [Disabled])
    await waitForToolList(
      mcpClient,
      tools => {
        const echo = tools.find(t => t.name === 'e2e-test_echo');
        return echo !== undefined && !echo.description.startsWith('[Disabled]');
      },
      15_000,
      300,
      'e2e-test_echo should not have [Disabled] prefix after Enable Anyway',
    );

    await sidePanel.close();
  });

  test('dialog "Cancel" does not change permission', async ({ mcpServer, extensionContext, mcpClient }) => {
    await waitForExtensionConnected(mcpServer);
    await waitForLog(mcpServer, 'tab.syncAll received');

    const sidePanel = await openSidePanel(extensionContext);
    await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

    // Attempt to change from 'off' to 'ask'
    const pluginTrigger = sidePanel.locator('[aria-label="Permission for e2e-test plugin"]');
    await expect(pluginTrigger).toBeVisible({ timeout: 5_000 });
    await selectPermission(sidePanel, 'Permission for e2e-test plugin', 'Ask');

    // Dialog should appear
    await waitForUnreviewedDialog(sidePanel);

    // Click "Cancel"
    await sidePanel.getByRole('button', { name: 'Cancel' }).click();

    // Dialog should close
    await expect(sidePanel.locator('[role="dialog"]')).toBeHidden({ timeout: 5_000 });

    // Permission should still be 'off' — tools should still be disabled
    const tools = await mcpClient.listTools();
    const echo = tools.find(t => t.name === 'e2e-test_echo');
    expect(echo?.description).toMatch(/^\[Disabled\]/);

    await sidePanel.close();
  });

  test('reviewed plugin permission change works without dialog', async ({ mcpServer, extensionContext, mcpClient }) => {
    const pluginVersion = getE2eTestPluginVersion();

    // Set the plugin as reviewed with 'off' permission
    const config = readTestConfig(mcpServer.configDir);
    config.permissions = {
      'e2e-test': {
        permission: 'off',
        reviewedVersion: pluginVersion,
      },
    };
    writeTestConfig(mcpServer.configDir, config);

    mcpServer.logs.length = 0;
    mcpServer.triggerHotReload();
    await waitForLog(mcpServer, 'Hot reload complete', 20_000);

    await waitForExtensionConnected(mcpServer);
    await waitForLog(mcpServer, 'tab.syncAll received');

    const sidePanel = await openSidePanel(extensionContext);
    await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

    // Change reviewed plugin from 'off' to 'auto' — no dialog expected
    const pluginTrigger = sidePanel.locator('[aria-label="Permission for e2e-test plugin"]');
    await expect(pluginTrigger).toBeVisible({ timeout: 5_000 });
    await selectPermission(sidePanel, 'Permission for e2e-test plugin', 'Auto');

    // Wait for the MCP server to reflect the change — no dialog should appear
    await waitForToolList(
      mcpClient,
      tools => {
        const echo = tools.find(t => t.name === 'e2e-test_echo');
        return echo !== undefined && !echo.description.startsWith('[Disabled]');
      },
      15_000,
      300,
      'e2e-test_echo should not have [Disabled] prefix after direct enable',
    );

    // Verify no dialog appeared (it should still be hidden)
    const dialogCount = await sidePanel.locator('[role="dialog"]').count();
    expect(dialogCount).toBe(0);

    await sidePanel.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — platform tools not visible in side panel
// ---------------------------------------------------------------------------

test.describe('Platform tools visibility', () => {
  test('plugin_inspect and plugin_mark_reviewed do not appear in side panel', async ({
    mcpServer,
    extensionContext,
  }) => {
    await waitForExtensionConnected(mcpServer);
    await waitForLog(mcpServer, 'tab.syncAll received');

    const sidePanel = await openSidePanel(extensionContext);
    await expect(sidePanel.getByText('E2E Test')).toBeVisible({ timeout: 30_000 });

    // Expand the plugin card to see all tools
    const pluginCard = sidePanel.locator('button[aria-expanded]').filter({ hasText: 'E2E Test' });
    await pluginCard.click();

    // The side panel content should not contain plugin_inspect or plugin_mark_reviewed
    const pageContent = await sidePanel.textContent('body');
    expect(pageContent).not.toContain('plugin_inspect');
    expect(pageContent).not.toContain('plugin_mark_reviewed');

    // But they should be present in the MCP tools/list (visible to AI agents)
    const client = createMcpClient(mcpServer.port, mcpServer.secret);
    await client.initialize();
    try {
      const tools = await client.listTools();
      const inspect = tools.find(t => t.name === 'plugin_inspect');
      const markReviewed = tools.find(t => t.name === 'plugin_mark_reviewed');

      expect(inspect).toBeDefined();
      expect(markReviewed).toBeDefined();

      // Platform tools should not have [Disabled] or [Requires approval] prefix
      expect(inspect?.description).not.toMatch(/^\[/);
      expect(markReviewed?.description).not.toMatch(/^\[/);
    } finally {
      await client.close();
    }

    await sidePanel.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — Browser tools error message has no review flow
// ---------------------------------------------------------------------------

test.describe('Browser tools — no review flow', () => {
  test('browser tool with permission off returns disabled error without review instructions', async ({ mcpClient }) => {
    // Browser tools default to 'off'. Calling one should NOT mention plugin_inspect.
    const result = await mcpClient.callTool('browser_list_tabs', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('currently disabled');
    expect(result.content).not.toContain('plugin_inspect');
    expect(result.content).not.toContain('has not been reviewed');
  });
});
