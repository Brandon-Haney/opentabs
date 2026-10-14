/**
 * E2E tests for session recovery — with the `sessionRecovery` setting on, a
 * plugin call that finds no tab or a rejected session opens the site in a
 * background tab and runs once more there; a site that stays signed out
 * answers NEEDS_LOGIN. With the setting off (the default, covered by the
 * tool-dispatch and dispatch-resilience suites) the same calls fail at once.
 *
 * Prerequisites (all pre-built, not created at test time):
 *   - `npm run build` has been run (platform dist/ files exist)
 *   - `plugins/e2e-test` has been built (`cd plugins/e2e-test && npm run build`)
 *   - Chromium is installed for Playwright
 *
 * All tests use dynamic ports and are safe for parallel execution.
 */

import type { McpClient, McpServer } from './fixtures.js';
import { expect, readTestConfig, test, writeTestConfig } from './fixtures.js';
import { callToolExpectSuccess, parseToolResult, setupToolTest, waitFor, waitForLog } from './helpers.js';

interface ListedTab {
  tabId: number;
  ready: boolean;
}

const listPluginTabs = async (mcpClient: McpClient): Promise<ListedTab[]> => {
  const result = await mcpClient.callTool('plugin_list_tabs', { plugin: 'e2e-test' });
  const [entry] = JSON.parse(result.content) as Array<{ tabs: ListedTab[] }>;
  return entry?.tabs ?? [];
};

/**
 * Turn the sessionRecovery setting on and wait for the reloaded server to know
 * the open test tab again: the new worker starts with an empty tab mapping
 * until the extension's next tab sync.
 */
const enableSessionRecovery = async (mcpServer: McpServer, mcpClient: McpClient): Promise<void> => {
  const config = readTestConfig(mcpServer.configDir);
  writeTestConfig(mcpServer.configDir, { ...config, sessionRecovery: true });
  mcpServer.logs.length = 0;
  mcpServer.triggerHotReload();
  await waitForLog(mcpServer, 'Hot reload complete', 20_000);
  await waitFor(
    async () => (await listPluginTabs(mcpClient)).some(tab => tab.ready),
    15_000,
    250,
    'the test tab to be reported ready after the reload',
  );
};

test.describe('Session recovery', () => {
  test('a call with no open tab reopens the site in the background and succeeds', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    test.slow();
    const page = await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);
    await enableSessionRecovery(mcpServer, mcpClient);
    const [original] = await listPluginTabs(mcpClient);
    expect(original?.ready).toBe(true);

    await page.close();
    await waitFor(
      async () => (await listPluginTabs(mcpClient)).length === 0,
      15_000,
      250,
      'the closed tab to leave the mapping',
    );

    const output = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test__echo', { message: 'recovered' });
    expect(output.message).toBe('recovered');

    const tabs = await listPluginTabs(mcpClient);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.tabId).not.toBe(original?.tabId);
    expect(tabs[0]?.ready).toBe(true);
  });

  test('a session the reopened page still rejects answers NEEDS_LOGIN naming the site', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    test.slow();
    await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);
    await enableSessionRecovery(mcpServer, mcpClient);

    // error_auth always throws ToolError.auth, so the retry in the new tab is rejected too. Recovery
    // may wait up to a minute for the new tab, longer than the client's default call timeout.
    const result = await mcpClient.callTool('e2e-test__error_auth', {}, { timeout: 90_000 });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('[ERROR code=NEEDS_LOGIN category=auth retryable=false]');
    const block = parseToolResult(
      result.content.slice(result.content.indexOf('{'), result.content.lastIndexOf('}') + 1),
    );
    expect(block).toMatchObject({ code: 'NEEDS_LOGIN', plugin: 'e2e-test' });
    expect(String(block.url)).toMatch(/^http:\/\/localhost:\d+\/$/);

    // The sign-in cooldown answers at once without opening another tab.
    const tabsBefore = (await listPluginTabs(mcpClient)).length;
    const again = await mcpClient.callTool('e2e-test__error_auth', {});
    expect(again.content).toContain('code=NEEDS_LOGIN');
    expect((await listPluginTabs(mcpClient)).length).toBe(tabsBefore);
  });

  test('plugin_check_sessions reports a signed-in tab, and a closed one after it goes', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    const page = await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);

    const check = async (): Promise<Record<string, unknown> | undefined> => {
      const result = await mcpClient.callTool('plugin_check_sessions', { plugins: ['e2e-test'] });
      return (JSON.parse(result.content) as Array<Record<string, unknown>>)[0];
    };

    expect(await check()).toMatchObject({ plugin: 'e2e-test', status: 'ready', tabs: 1 });

    await page.close();
    await waitFor(async () => (await check())?.status === 'no_tab', 15_000, 250, 'the plugin to report no_tab');
  });
});
