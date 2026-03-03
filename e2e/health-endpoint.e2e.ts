/**
 * E2E tests for the /health endpoint — plugin details, failed plugins,
 * and tab state transitions as consumed by the `opentabs doctor` command.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupTestConfigDir,
  E2E_TEST_PLUGIN_DIR,
  expect,
  readPluginToolNames,
  startMcpServer,
  test,
  writeTestConfig,
} from './fixtures.js';
import { setupToolTest } from './helpers.js';

// ---------------------------------------------------------------------------
// US-009: Health endpoint plugin details
// ---------------------------------------------------------------------------

test.describe('Health endpoint — plugin details', () => {
  test('returns pluginDetails with correct source, tabState, toolCount, and sdkVersion', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    const page = await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);

    // Poll until the tabState is 'ready' in the health endpoint — the server's
    // tabMapping may lag slightly behind the extension's isReady probe.
    const health = await mcpServer.waitForHealth(h => {
      const plugin = h.pluginDetails?.find(p => p.name === 'e2e-test');
      return plugin?.tabState === 'ready';
    });

    const details = health.pluginDetails;
    expect(details).toBeDefined();
    expect(details?.length).toBeGreaterThanOrEqual(1);

    const e2ePlugin = details?.find(p => p.name === 'e2e-test');
    expect(e2ePlugin).toBeDefined();
    expect(e2ePlugin?.source).toBe('local');
    expect(e2ePlugin?.toolCount).toBeGreaterThan(0);
    expect(e2ePlugin?.tabState).toBe('ready');
    expect(e2ePlugin?.sdkVersion).toBeDefined();
    expect(typeof e2ePlugin?.sdkVersion).toBe('string');
    expect(e2ePlugin?.logBufferSize).toBeGreaterThanOrEqual(0);
    expect(e2ePlugin?.displayName).toBeTruthy();

    await page.close();
  });

  test('health endpoint top-level fields are accurate', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    const page = await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);

    const headers: Record<string, string> = {};
    if (mcpServer.secret) headers.Authorization = `Bearer ${mcpServer.secret}`;

    const res = await fetch(`http://localhost:${String(mcpServer.port)}/health`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.ok).toBe(true);
    const health = (await res.json()) as Record<string, unknown>;

    expect(health.status).toBe('ok');
    expect(typeof health.version).toBe('string');
    expect(typeof health.sdkVersion).toBe('string');
    expect(health.extensionConnected).toBe(true);
    expect(typeof health.mcpClients).toBe('number');
    expect(health.mcpClients as number).toBeGreaterThanOrEqual(1);
    expect(typeof health.plugins).toBe('number');
    expect(health.plugins as number).toBeGreaterThanOrEqual(1);
    expect(typeof health.toolCount).toBe('number');
    expect(health.toolCount as number).toBeGreaterThan(0);
    expect(typeof health.uptime).toBe('number');
    expect(health.uptime as number).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(health.failedPlugins)).toBe(true);
    expect(Array.isArray(health.discoveryErrors)).toBe(true);

    await page.close();
  });
});

// ---------------------------------------------------------------------------
// US-012: Live tab state query from extension
// ---------------------------------------------------------------------------

test.describe('Health endpoint — live tab state query', () => {
  test('/health returns live tab state with per-tab details when extension connected', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    const page = await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);

    // Poll /health until the e2e-test plugin has live tab details
    const health = await mcpServer.waitForHealth(h => {
      const plugin = h.pluginDetails?.find(p => p.name === 'e2e-test');
      return plugin?.tabState === 'ready' && Array.isArray(plugin.tabs) && plugin.tabs.length > 0;
    });

    const e2ePlugin = health.pluginDetails?.find(p => p.name === 'e2e-test');
    expect(e2ePlugin).toBeDefined();
    expect(e2ePlugin?.tabState).toBe('ready');
    expect(e2ePlugin?.tabs?.length).toBeGreaterThan(0);

    // Verify per-tab details are present (comes from extension's live state)
    const tab = e2ePlugin?.tabs?.[0] as { tabId?: number; url?: string; ready?: boolean } | undefined;
    expect(tab).toBeDefined();
    expect(typeof tab?.tabId).toBe('number');
    expect(typeof tab?.url).toBe('string');
    expect(tab?.ready).toBe(true);

    await page.close();
  });
});

// ---------------------------------------------------------------------------
// US-009: Failed plugins in health endpoint
// ---------------------------------------------------------------------------

test.describe('Health endpoint — failed plugins', () => {
  test('nonexistent local plugin path is silently skipped, valid plugin still loads', async () => {
    const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
    const prefixedToolNames = readPluginToolNames();
    const tools: Record<string, boolean> = {};
    for (const t of prefixedToolNames) {
      tools[t] = true;
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-health-fail-'));
    const bogusPath = path.join(os.tmpdir(), `nonexistent-opentabs-plugin-${String(Date.now())}`);
    writeTestConfig(configDir, {
      localPlugins: [absPluginPath, bogusPath],
      tools,
    });

    const server = await startMcpServer(configDir, true);
    try {
      const health = await server.waitForHealth(h => h.status === 'ok');
      const authHeaders: Record<string, string> = {};
      if (server.secret) authHeaders.Authorization = `Bearer ${server.secret}`;

      const raw = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await raw.json()) as Record<string, unknown>;

      // Nonexistent paths are treated as stale config entries and silently
      // skipped — they do not appear in failedPlugins.
      const failedPlugins = body.failedPlugins as Array<{ path: string; error: string }>;
      const bogusFailure = failedPlugins.find(f => f.path.includes('nonexistent-opentabs-plugin'));
      expect(bogusFailure).toBeUndefined();

      // Stale paths still appear in discoveryErrors for diagnostic visibility.
      const discoveryErrors = body.discoveryErrors as Array<{ specifier: string; error: string }>;
      const staleError = discoveryErrors.find(e => e.specifier.includes('nonexistent-opentabs-plugin'));
      expect(staleError).toBeDefined();
      expect(staleError?.error).toContain('Path not found');

      // The valid e2e-test plugin should still load successfully
      expect(health.pluginDetails).toBeDefined();
      const e2ePlugin = health.pluginDetails?.find(p => p.name === 'e2e-test');
      expect(e2ePlugin).toBeDefined();
    } finally {
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// US-009: Tab state transitions in health endpoint
// ---------------------------------------------------------------------------

test.describe('Health endpoint — tab state transitions', () => {
  test('tabState changes to unavailable after auth toggle off', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    const page = await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);

    // Verify tabState is 'ready' initially
    await expect
      .poll(
        async () => {
          const pollHeaders: Record<string, string> = {};
          if (mcpServer.secret) pollHeaders.Authorization = `Bearer ${mcpServer.secret}`;
          const res = await fetch(`http://localhost:${String(mcpServer.port)}/health`, {
            headers: pollHeaders,
          });
          const body = (await res.json()) as {
            pluginDetails?: Array<{ name: string; tabState: string }>;
          };
          return body.pluginDetails?.find(p => p.name === 'e2e-test')?.tabState;
        },
        { timeout: 15_000, message: 'tabState should be ready initially' },
      )
      .toBe('ready');

    // Toggle auth off — isReady() will return false
    await testServer.setAuth(false);

    // Force page reload so the extension re-probes isReady
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      },
      { timeout: 10_000 },
    );

    // Poll /health until tabState becomes 'unavailable'
    await expect
      .poll(
        async () => {
          const pollHeaders: Record<string, string> = {};
          if (mcpServer.secret) pollHeaders.Authorization = `Bearer ${mcpServer.secret}`;
          const res = await fetch(`http://localhost:${String(mcpServer.port)}/health`, {
            headers: pollHeaders,
          });
          const body = (await res.json()) as {
            pluginDetails?: Array<{ name: string; tabState: string }>;
          };
          return body.pluginDetails?.find(p => p.name === 'e2e-test')?.tabState;
        },
        {
          timeout: 30_000,
          message: 'tabState should transition to unavailable after auth off',
        },
      )
      .toBe('unavailable');

    // Toggle auth back on — tabState should recover to 'ready'
    await testServer.setAuth(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.['e2e-test'] !== undefined;
      },
      { timeout: 10_000 },
    );

    await expect
      .poll(
        async () => {
          const pollHeaders: Record<string, string> = {};
          if (mcpServer.secret) pollHeaders.Authorization = `Bearer ${mcpServer.secret}`;
          const res = await fetch(`http://localhost:${String(mcpServer.port)}/health`, {
            headers: pollHeaders,
          });
          const body = (await res.json()) as {
            pluginDetails?: Array<{ name: string; tabState: string }>;
          };
          return body.pluginDetails?.find(p => p.name === 'e2e-test')?.tabState;
        },
        {
          timeout: 30_000,
          message: 'tabState should recover to ready after auth on',
        },
      )
      .toBe('ready');

    await page.close();
  });
});
