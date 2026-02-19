/**
 * Strict CSP E2E tests — proves the full tool dispatch path works against a page
 * with `script-src 'none'` and other maximally restrictive security headers.
 *
 * The strict-CSP test server blocks ALL JavaScript execution via CSP, yet
 * chrome.scripting.executeScript bypasses page CSP entirely because it runs
 * in a privileged extension context. These tests verify that adapter injection,
 * tool dispatch, and state management all work correctly on the most locked-down
 * websites.
 *
 * Uses the existing e2e-test plugin (plugins/e2e-test) — the same adapter works
 * on both the regular and strict-CSP test server because URL patterns match
 * http://localhost/*.
 *
 * All tests use dynamic ports and are safe for parallel execution.
 */

import {
  expect,
  test as fixtureTest,
  copyE2eTestPlugin,
  createMcpClient,
  createMinimalPlugin,
  startMcpServer,
  startStrictCspServer,
  launchExtensionContext,
  cleanupTestConfigDir,
  readPluginToolNames,
  readTestConfig,
  writeTestConfig,
} from './fixtures.js';
import {
  waitFor,
  waitForLog,
  waitForExtensionConnected,
  waitForToolList,
  openTestAppTab,
  parseToolResult,
  waitForToolResult,
  callToolExpectSuccess,
} from './helpers.js';
import { test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpClient, McpServer, TestServer } from './fixtures.js';
import type { BrowserContext, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Setup helper — strict-CSP variant of setupToolTest
// ---------------------------------------------------------------------------

/**
 * Standard test preamble for strict-CSP tests: wait for extension, open tab
 * to the strict-CSP server, poll until the e2e-test plugin reports "ready".
 */
const setupStrictCspToolTest = async (
  mcpServer: McpServer,
  strictCspServer: TestServer,
  extensionContext: BrowserContext,
  mcpClient: McpClient,
): Promise<Page> => {
  await waitForExtensionConnected(mcpServer);
  await waitForLog(mcpServer, 'tab.syncAll received');
  await strictCspServer.reset();

  const page = await openTestAppTab(extensionContext, strictCspServer.url, mcpServer);

  // Poll until the tool is callable (tab state = ready)
  await waitForToolResult(mcpClient, 'e2e-test_get_status', {}, { isError: false }, 15_000);

  return page;
};

// ---------------------------------------------------------------------------
// Strict CSP — full tool dispatch
// ---------------------------------------------------------------------------

fixtureTest.describe('Strict CSP — full tool dispatch', () => {
  fixtureTest(
    'adapter injects and tools work on a page with script-src none CSP',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Verify the adapter is injected
      const adapterExists = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      });
      expect(adapterExists).toBe(true);

      // Call echo tool through the full MCP stack
      const output = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'strict-csp roundtrip',
      });
      expect(output.ok).toBe(true);
      expect(output.message).toBe('strict-csp roundtrip');

      await page.close();
    },
  );

  fixtureTest(
    'isReady probe works through same-origin fetch despite strict CSP',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Tool should succeed with auth on (default)
      const okOutput = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'auth on',
      });
      expect(okOutput.message).toBe('auth on');

      // Toggle auth off — isReady() should return false, tools become unavailable
      await strictCspServer.setAuth(false);

      const failResult = await waitForToolResult(
        mcpClient,
        'e2e-test_echo',
        { message: 'auth off' },
        { isError: true },
      );
      expect(failResult.content.toLowerCase()).toMatch(/unavailable|not ready/);

      // Restore auth — tools should recover
      await strictCspServer.setAuth(true);

      const recoveredResult = await waitForToolResult(
        mcpClient,
        'e2e-test_echo',
        { message: 'auth restored' },
        { isError: false },
      );
      const recoveredOutput = parseToolResult(recoveredResult.content);
      expect(recoveredOutput.message).toBe('auth restored');

      await page.close();
    },
  );

  fixtureTest(
    'multiple tools dispatch correctly on strict-CSP page',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Echo
      const echoOutput = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'csp-echo',
      });
      expect(echoOutput.ok).toBe(true);
      expect(echoOutput.message).toBe('csp-echo');

      // Greet
      const greetOutput = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_greet', {
        name: 'CSP',
      });
      expect(greetOutput.ok).toBe(true);
      expect(greetOutput.greeting).toBe('Hello, CSP!');

      // Get status
      const statusOutput = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_get_status', {});
      expect(statusOutput.ok).toBe(true);
      expect(statusOutput.authenticated).toBe(true);
      expect(statusOutput.version).toBe('1.0.0-test');

      await page.close();
    },
  );

  fixtureTest(
    'strict-CSP server records invocations from plugin adapter',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Clear invocations after setup (setup generates auth.check calls)
      await strictCspServer.reset();

      // Make tool calls
      await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', { message: 'inv-test' });
      await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_greet', { name: 'Invocation' });
      await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_get_status', {});

      // Fetch invocation log from the strict-CSP test server
      const invocations = await strictCspServer.invocations();
      const toolInvocations = invocations.filter(i => i.path !== '/api/auth.check');

      const paths = toolInvocations.map(i => i.path);
      expect(paths).toContain('/api/echo');
      expect(paths).toContain('/api/greet');
      expect(paths).toContain('/api/status');

      // Verify bodies were correctly relayed
      const echoInv = toolInvocations.find(i => i.path === '/api/echo');
      expect(echoInv).toBeDefined();
      if (!echoInv) throw new Error('echoInv not found');
      expect((echoInv.body as Record<string, unknown>).message).toBe('inv-test');

      const greetInv = toolInvocations.find(i => i.path === '/api/greet');
      expect(greetInv).toBeDefined();
      if (!greetInv) throw new Error('greetInv not found');
      expect((greetInv.body as Record<string, unknown>).name).toBe('Invocation');

      await page.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Strict CSP — verification that page scripts are truly blocked
// ---------------------------------------------------------------------------

fixtureTest.describe('Strict CSP — CSP enforcement verification', () => {
  fixtureTest(
    'strict-CSP server blocks inline scripts (validates test server is truly strict)',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Attempt to add an inline script via page.evaluate — the script element
      // is inserted into the DOM but CSP blocks its execution.
      const scriptExecuted = await page.evaluate(() => {
        (globalThis as Record<string, unknown>).__cspTestMarker = undefined;
        const script = document.createElement('script');
        script.textContent = '(globalThis).__cspTestMarker = "executed"';
        document.head.appendChild(script);
        return (globalThis as Record<string, unknown>).__cspTestMarker === 'executed';
      });

      // CSP script-src 'none' blocks the inline script — marker stays undefined
      expect(scriptExecuted).toBe(false);

      // The extension's adapter still works despite the strict CSP
      const adapterExists = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      });
      expect(adapterExists).toBe(true);

      // Full tool dispatch still works
      const output = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'csp-verification',
      });
      expect(output.ok).toBe(true);
      expect(output.message).toBe('csp-verification');

      await page.close();
    },
  );

  fixtureTest(
    'adapter re-injection after page reload works on strict-CSP page',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Verify adapter is injected before reload
      const beforeReload = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      });
      expect(beforeReload).toBe(true);

      // Reload the page — clears the JS context including the adapter
      await page.reload({ waitUntil: 'load' });

      // Wait for the extension to re-inject the adapter after reload.
      // The extension's tabs.onUpdated listener (status: 'complete') triggers
      // injectPluginsIntoTab which re-injects into matching tabs.
      await waitFor(
        async () => {
          const injected = await page.evaluate(() => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | { adapters?: Record<string, unknown> }
              | undefined;
            return ot?.adapters?.['e2e-test'] !== undefined;
          });
          return injected;
        },
        15_000,
        500,
        'adapter re-injected after reload',
      );

      // Tool dispatch works after re-injection
      await waitForToolResult(mcpClient, 'e2e-test_get_status', {}, { isError: false }, 15_000);

      const output = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'after-reload',
      });
      expect(output.ok).toBe(true);
      expect(output.message).toBe('after-reload');

      await page.close();
    },
  );

  fixtureTest(
    'page has no script elements (CSP prevents all script tags)',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // The strict-CSP page HTML has no <script> tags, and CSP blocks dynamic
      // script element creation. document.scripts should be empty.
      const scriptCount = await page.evaluate(() => document.scripts.length);
      expect(scriptCount).toBe(0);

      // The adapter runs because chrome.scripting.executeScript evaluates code
      // directly in the JS context — it does not create script elements.
      const adapterExists = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      });
      expect(adapterExists).toBe(true);

      // Verify full tool dispatch works
      const output = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'no-script-elements',
      });
      expect(output.ok).toBe(true);
      expect(output.message).toBe('no-script-elements');

      await page.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Strict CSP — plugin.update re-injection
// ---------------------------------------------------------------------------

fixtureTest.describe('Strict CSP — plugin.update re-injection', () => {
  fixtureTest(
    'adapter survives hot reload on a strict-CSP page',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Baseline: adapter is present and tool dispatch works
      const baseline = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'before-hot-reload',
      });
      expect(baseline.message).toBe('before-hot-reload');

      // Trigger hot reload — MCP server re-discovers plugins and sends sync.full.
      // sync.full uses forceReinject=false, so the existing adapter is preserved.
      mcpServer.logs.length = 0;
      mcpServer.triggerHotReload();

      await waitForLog(mcpServer, 'Hot reload complete', 20_000);
      await waitForLog(mcpServer, 'tab.syncAll received', 20_000);

      // Adapter should still be present after sync.full (not torn down)
      const adapterAfter = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      });
      expect(adapterAfter).toBe(true);

      // Tool dispatch still works after hot reload on strict-CSP page
      const afterResult = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'after-hot-reload-csp',
      });
      expect(afterResult.message).toBe('after-hot-reload-csp');

      await page.close();
    },
  );

  fixtureTest(
    'adapter re-injects after page reload following hot reload on strict-CSP page',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Trigger hot reload so plugin metadata is re-synced
      mcpServer.logs.length = 0;
      mcpServer.triggerHotReload();

      await waitForLog(mcpServer, 'Hot reload complete', 20_000);
      await waitForLog(mcpServer, 'tab.syncAll received', 20_000);

      // Reload the page — clears the JS context including the adapter.
      // The extension's tabs.onUpdated listener (status: 'complete') triggers
      // injectPluginsIntoTab which re-injects the adapter from stored metadata.
      await page.reload({ waitUntil: 'load' });

      // Wait for the adapter to be re-injected despite strict CSP
      await waitFor(
        async () => {
          const injected = await page.evaluate(() => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | { adapters?: Record<string, unknown> }
              | undefined;
            return ot?.adapters?.['e2e-test'] !== undefined;
          });
          return injected;
        },
        15_000,
        500,
        'adapter re-injected after page reload on strict-CSP page',
      );

      // Tool dispatch works after re-injection on strict-CSP page
      await waitForToolResult(mcpClient, 'e2e-test_get_status', {}, { isError: false }, 15_000);

      const output = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'after-reload-csp',
      });
      expect(output.message).toBe('after-reload-csp');

      await page.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Strict CSP — connect-src 'none' blocks fetch, documenting expected behavior
// ---------------------------------------------------------------------------

fixtureTest.describe('Strict CSP — connect-src blocks fetch', () => {
  fixtureTest(
    'adapter injects but isReady returns false when connect-src blocks fetch',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      await waitForExtensionConnected(mcpServer);
      await waitForLog(mcpServer, 'tab.syncAll received');

      // Enable connect-src 'none' — all fetch requests from the page will be blocked.
      // The adapter is injected via chrome.scripting.executeScript (bypasses CSP),
      // but isReady() calls fetch('/api/auth.check') which is subject to connect-src.
      await strictCspServer.control('set-connect-src', { connectSrcNone: true });

      // Open a tab to the strict-CSP server with connect-src 'none' active.
      // openTestAppTab polls for adapter presence in __openTabs.adapters — the
      // adapter injects because chrome.scripting.executeScript is privileged.
      const page = await openTestAppTab(extensionContext, strictCspServer.url, mcpServer);

      // Verify the adapter is injected (chrome.scripting.executeScript bypasses CSP)
      const adapterExists = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      });
      expect(adapterExists).toBe(true);

      // Tool dispatch should return isError=true because isReady() returns false.
      // The adapter's isReady() calls fetch('/api/auth.check'), which is blocked
      // by connect-src 'none' — so the tab state stays 'unavailable'.
      const failResult = await waitForToolResult(
        mcpClient,
        'e2e-test_echo',
        { message: 'should-fail' },
        { isError: true },
        15_000,
      );
      expect(failResult.content.toLowerCase()).toMatch(/unavailable|not ready/);

      await page.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Strict CSP — file watcher IIFE change triggers force re-injection
// ---------------------------------------------------------------------------

test.describe('Strict CSP — file watcher IIFE re-injection', () => {
  test('modified IIFE is force re-injected into strict-CSP tab after file watcher detects change', async () => {
    const { pluginDir, tmpDir } = copyE2eTestPlugin();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-csp-iife-reinject-'));

    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }
    writeTestConfig(configDir, { plugins: [pluginDir], tools });

    const server = await startMcpServer(configDir, true);
    const strictCspSrv = await startStrictCspServer();

    const { context, cleanupDir, extensionDir } = await launchExtensionContext(server.port);
    const serverAdaptersParent = path.join(configDir, 'extension');
    fs.mkdirSync(serverAdaptersParent, { recursive: true });
    const serverAdaptersDir = path.join(serverAdaptersParent, 'adapters');
    const extensionAdaptersDir = path.join(extensionDir, 'adapters');
    fs.rmSync(serverAdaptersDir, { recursive: true, force: true });
    fs.symlinkSync(extensionAdaptersDir, serverAdaptersDir);

    const client = createMcpClient(server.port, server.secret);

    try {
      await client.initialize();
      await waitForExtensionConnected(server);
      await waitForLog(server, 'tab.syncAll received');

      // Open a tab to the strict-CSP test server and wait for adapter injection
      const page = await openTestAppTab(context, strictCspSrv.url, server);

      // Poll until tool dispatch works (tab state = ready)
      await waitForToolResult(client, 'e2e-test_get_status', {}, { isError: false }, 15_000);

      // Baseline: adapter is present and tool dispatch works on strict-CSP page
      const baseline = await callToolExpectSuccess(client, server, 'e2e-test_echo', {
        message: 'csp-before-update',
      });
      expect(baseline.message).toBe('csp-before-update');

      // Verify no update marker is set initially
      const markerBefore = await page.evaluate(() => (globalThis as Record<string, unknown>).__e2eReinjectMarker);
      expect(markerBefore).toBeUndefined();

      // Modify the IIFE to set a global marker variable on re-injection.
      // The marker is a global (not a property on the adapter) because the
      // adapter is frozen by the hash-setter snippet appended by opentabs build.
      const iifePath = path.join(pluginDir, 'dist', 'adapter.iife.js');
      const originalIife = fs.readFileSync(iifePath, 'utf-8');
      const markerCode = [
        '',
        '// Injected by E2E test to verify re-injection on strict-CSP page',
        'globalThis.__e2eReinjectMarker = true;',
      ].join('\n');
      const modifiedIife = originalIife.replace(/}\)\(\);[\s]*$/, `${markerCode}\n})();\n`);
      fs.writeFileSync(iifePath, modifiedIife, 'utf-8');

      // Wait for the file watcher to detect the IIFE change and send plugin.update
      await waitForLog(server, 'IIFE updated for', 15_000);

      // Wait for the marker to appear in the page (proves re-injection happened
      // on the strict-CSP page despite script-src 'none')
      await waitFor(
        async () => {
          const marker = await page.evaluate(
            () => (globalThis as Record<string, unknown>).__e2eReinjectMarker === true,
          );
          return marker;
        },
        15_000,
        500,
        '__e2eReinjectMarker to be true after re-injection on strict-CSP page',
      );

      // Tool dispatch still works after re-injection on strict-CSP page
      const afterResult = await callToolExpectSuccess(client, server, 'e2e-test_echo', {
        message: 'csp-after-update',
      });
      expect(afterResult.message).toBe('csp-after-update');

      await page.close();
    } finally {
      await client.close();
      await context.close();
      await server.kill();
      await strictCspSrv.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Strict CSP — multiple plugins injected simultaneously
// ---------------------------------------------------------------------------

fixtureTest.describe('Strict CSP — multiple plugins on same page', () => {
  fixtureTest(
    'two plugins both inject adapters into a strict-CSP page despite script-src none',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Baseline: e2e-test adapter is present and tool dispatch works
      const baseline = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'csp-before-second-plugin',
      });
      expect(baseline.message).toBe('csp-before-second-plugin');

      // Create a minimal second plugin matching http://localhost/*
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-csp-multi-plugin-'));
      const extraPluginDir = createMinimalPlugin(tmpDir, 'csp-extra-plugin', [
        { name: 'noop', description: 'No-op tool for strict-CSP multi-plugin test' },
      ]);

      // Add the second plugin to the config and enable its tool
      const config = readTestConfig(mcpServer.configDir);
      config.plugins.push(extraPluginDir);
      config.tools['csp-extra-plugin_noop'] = true;
      writeTestConfig(mcpServer.configDir, config);

      // Trigger hot reload — server discovers both plugins, sends sync.full
      mcpServer.logs.length = 0;
      mcpServer.triggerHotReload();

      await waitForLog(mcpServer, 'Hot reload complete', 20_000);
      await waitForLog(mcpServer, 'tab.syncAll received', 20_000);

      // Wait for the extra plugin's tool to appear in the MCP tool list
      await waitForToolList(
        mcpClient,
        list => list.some(t => t.name === 'csp-extra-plugin_noop'),
        10_000,
        300,
        'csp-extra-plugin_noop to appear in tool list',
      );

      // Wait for both adapters to be present in the strict-CSP page
      await waitFor(
        async () => {
          const adapters = await page.evaluate(() => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | { adapters?: Record<string, unknown> }
              | undefined;
            return {
              e2eTest: ot?.adapters?.['e2e-test'] !== undefined,
              extraPlugin: ot?.adapters?.['csp-extra-plugin'] !== undefined,
            };
          });
          return adapters.e2eTest && adapters.extraPlugin;
        },
        15_000,
        500,
        'both e2e-test and csp-extra-plugin adapters to be present on strict-CSP page',
      );

      // Verify both adapter names are in the page
      const adapterNames = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return Object.keys(ot?.adapters ?? {}).sort();
      });
      expect(adapterNames).toContain('csp-extra-plugin');
      expect(adapterNames).toContain('e2e-test');

      await page.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  );

  fixtureTest(
    'e2e-test tool dispatch works on strict-CSP page with two adapters present',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Add a second plugin
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-csp-dispatch-'));
      const extraPluginDir = createMinimalPlugin(tmpDir, 'csp-dispatch-extra', [
        { name: 'noop', description: 'No-op tool for dispatch test' },
      ]);

      const config = readTestConfig(mcpServer.configDir);
      config.plugins.push(extraPluginDir);
      config.tools['csp-dispatch-extra_noop'] = true;
      writeTestConfig(mcpServer.configDir, config);

      mcpServer.logs.length = 0;
      mcpServer.triggerHotReload();

      await waitForLog(mcpServer, 'Hot reload complete', 20_000);
      await waitForLog(mcpServer, 'tab.syncAll received', 20_000);

      // Wait for both adapters
      await waitFor(
        async () => {
          const adapters = await page.evaluate(() => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | { adapters?: Record<string, unknown> }
              | undefined;
            return {
              e2eTest: ot?.adapters?.['e2e-test'] !== undefined,
              extraPlugin: ot?.adapters?.['csp-dispatch-extra'] !== undefined,
            };
          });
          return adapters.e2eTest && adapters.extraPlugin;
        },
        15_000,
        500,
        'both adapters present for dispatch test',
      );

      // e2e-test tool dispatch works with two adapters on the strict-CSP page
      const echoResult = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'csp-dual-adapter-echo',
      });
      expect(echoResult.ok).toBe(true);
      expect(echoResult.message).toBe('csp-dual-adapter-echo');

      const greetResult = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_greet', {
        name: 'DualCSP',
      });
      expect(greetResult.ok).toBe(true);
      expect(greetResult.greeting).toBe('Hello, DualCSP!');

      await page.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  );

  fixtureTest(
    'removing one plugin does not affect the other on a strict-CSP page',
    async ({ mcpServer, strictCspServer, extensionContext, mcpClient }) => {
      const page = await setupStrictCspToolTest(mcpServer, strictCspServer, extensionContext, mcpClient);

      // Add a second plugin
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-csp-remove-'));
      const extraPluginDir = createMinimalPlugin(tmpDir, 'csp-removable', [
        { name: 'noop', description: 'No-op tool for removal test' },
      ]);

      const config = readTestConfig(mcpServer.configDir);
      config.plugins.push(extraPluginDir);
      config.tools['csp-removable_noop'] = true;
      writeTestConfig(mcpServer.configDir, config);

      mcpServer.logs.length = 0;
      mcpServer.triggerHotReload();

      await waitForLog(mcpServer, 'Hot reload complete', 20_000);
      await waitForLog(mcpServer, 'tab.syncAll received', 20_000);

      // Wait for both adapters to be present
      await waitFor(
        async () => {
          const adapters = await page.evaluate(() => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | { adapters?: Record<string, unknown> }
              | undefined;
            return {
              e2eTest: ot?.adapters?.['e2e-test'] !== undefined,
              extraPlugin: ot?.adapters?.['csp-removable'] !== undefined,
            };
          });
          return adapters.e2eTest && adapters.extraPlugin;
        },
        15_000,
        500,
        'both adapters present before removal',
      );

      // Verify e2e-test tool dispatch works with both adapters
      const beforeRemoval = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'csp-before-removal',
      });
      expect(beforeRemoval.message).toBe('csp-before-removal');

      // Remove the second plugin from config (keep only e2e-test)
      const updatedConfig = readTestConfig(mcpServer.configDir);
      updatedConfig.plugins = updatedConfig.plugins.filter(p => !p.includes('csp-removable'));
      delete updatedConfig.tools['csp-removable_noop'];
      writeTestConfig(mcpServer.configDir, updatedConfig);

      // Trigger hot reload — server discovers only e2e-test, sends sync.full
      mcpServer.logs.length = 0;
      mcpServer.triggerHotReload();

      await waitForLog(mcpServer, 'Hot reload complete', 20_000);
      await waitForLog(mcpServer, 'tab.syncAll received', 20_000);

      // Wait for the removed plugin's tool to disappear from the tool list
      await waitForToolList(
        mcpClient,
        list => !list.some(t => t.name === 'csp-removable_noop'),
        10_000,
        300,
        'csp-removable_noop to be removed from tool list',
      );

      // e2e-test adapter and tool dispatch still works on the strict-CSP page
      // after the second plugin was removed
      await waitForToolResult(mcpClient, 'e2e-test_get_status', {}, { isError: false }, 15_000);

      const afterRemoval = await callToolExpectSuccess(mcpClient, mcpServer, 'e2e-test_echo', {
        message: 'csp-after-removal',
      });
      expect(afterRemoval.ok).toBe(true);
      expect(afterRemoval.message).toBe('csp-after-removal');

      // Verify e2e-test adapter is still present in the page
      const adapterPresent = await page.evaluate(() => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      });
      expect(adapterPresent).toBe(true);

      await page.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  );
});
