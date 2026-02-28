/**
 * E2E tests for plugin discovery edge cases — verify that broken plugins
 * produce clear errors in failedPlugins, that valid plugins still load when
 * one is broken, and that fixing a broken plugin transitions it to healthy.
 *
 * All tests use isolated config directories and dynamic ports for parallel
 * execution safety.
 */

import {
  test,
  expect,
  startMcpServer,
  createMcpClient,
  cleanupTestConfigDir,
  writeTestConfig,
  createMinimalPlugin,
  readPluginToolNames,
  E2E_TEST_PLUGIN_DIR,
} from './fixtures.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer, McpClient } from './fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a config with the e2e-test plugin plus any additional localPlugins.
 * Returns the config object ready for writeTestConfig.
 */
const configWithPlugins = (
  extraLocalPlugins: string[],
  extraTools: Record<string, boolean> = {},
): { localPlugins: string[]; tools: Record<string, boolean> } => {
  const absPluginPath = path.resolve(E2E_TEST_PLUGIN_DIR);
  const prefixedToolNames = readPluginToolNames();
  const tools: Record<string, boolean> = {};
  for (const t of prefixedToolNames) {
    tools[t] = true;
  }
  return {
    localPlugins: [absPluginPath, ...extraLocalPlugins],
    tools: { ...tools, ...extraTools },
  };
};

// ---------------------------------------------------------------------------
// US-009: Discovery edge cases — broken plugins
// ---------------------------------------------------------------------------

test.describe('Discovery edge cases — broken plugins', () => {
  test('non-existent local plugin path is silently skipped, valid plugin still loads', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-nodir-'));
    const bogusPath = path.join(os.tmpdir(), `nonexistent-plugin-${String(Date.now())}`);
    const config = configWithPlugins([bogusPath]);
    writeTestConfig(configDir, config);

    let server: McpServer | undefined;
    try {
      server = await startMcpServer(configDir, true);
      const health = await server.waitForHealth(h => h.status === 'ok');

      const raw = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await raw.json()) as {
        failedPlugins: Array<{ path: string; error: string }>;
        discoveryErrors: Array<{ specifier: string; error: string }>;
        pluginDetails?: Array<{ name: string }>;
      };

      // Nonexistent paths are treated as stale config entries and silently
      // skipped — they do not appear in failedPlugins.
      const failure = body.failedPlugins.find(f => f.path.includes('nonexistent-plugin'));
      expect(failure).toBeUndefined();

      // Stale paths still appear in discoveryErrors for diagnostic visibility.
      const staleError = body.discoveryErrors.find(e => e.specifier.includes('nonexistent-plugin'));
      expect(staleError).toBeDefined();
      expect(staleError?.error).toContain('Path not found');

      // The valid e2e-test plugin should still load
      expect(health.pluginDetails).toBeDefined();
      const e2ePlugin = health.pluginDetails?.find(p => p.name === 'e2e-test');
      expect(e2ePlugin).toBeDefined();
    } finally {
      await server?.kill();
      cleanupTestConfigDir(configDir);
    }
  });

  test('local plugin with missing dist/tools.json appears in failedPlugins', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-notools-'));

    // Create a plugin directory with package.json and adapter IIFE but no tools.json
    const pluginDir = path.join(tmpDir, 'broken-no-tools');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-broken-no-tools',
        version: '0.0.1',
        type: 'module',
        main: 'dist/adapter.iife.js',
        opentabs: {
          displayName: 'Broken No Tools',
          description: 'Plugin with missing tools.json',
          urlPatterns: ['http://localhost/*'],
        },
      }),
    );
    fs.writeFileSync(path.join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})();');
    // Intentionally NOT writing dist/tools.json

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-notools-cfg-'));
    const config = configWithPlugins([path.resolve(pluginDir)]);
    writeTestConfig(configDir, config);

    let server: McpServer | undefined;
    try {
      server = await startMcpServer(configDir, true);
      await server.waitForHealth(h => h.status === 'ok');

      const raw = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await raw.json()) as {
        failedPlugins: Array<{ path: string; error: string }>;
      };

      const failure = body.failedPlugins.find(f => f.path.includes('broken-no-tools'));
      expect(failure).toBeDefined();
      expect(failure?.error).toContain('tools.json');
    } finally {
      await server?.kill();
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('local plugin with invalid JSON in dist/tools.json appears in failedPlugins', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-badjson-'));

    // Create a plugin directory with all files but tools.json has invalid JSON
    const pluginDir = path.join(tmpDir, 'broken-bad-json');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-broken-bad-json',
        version: '0.0.1',
        type: 'module',
        main: 'dist/adapter.iife.js',
        opentabs: {
          displayName: 'Broken Bad JSON',
          description: 'Plugin with invalid tools.json',
          urlPatterns: ['http://localhost/*'],
        },
      }),
    );
    fs.writeFileSync(path.join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})();');
    fs.writeFileSync(path.join(pluginDir, 'dist', 'tools.json'), '{ this is not valid json !!!');

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-badjson-cfg-'));
    const config = configWithPlugins([path.resolve(pluginDir)]);
    writeTestConfig(configDir, config);

    let server: McpServer | undefined;
    try {
      server = await startMcpServer(configDir, true);
      await server.waitForHealth(h => h.status === 'ok');

      const raw = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await raw.json()) as {
        failedPlugins: Array<{ path: string; error: string }>;
      };

      const failure = body.failedPlugins.find(f => f.path.includes('broken-bad-json'));
      expect(failure).toBeDefined();
      expect(failure?.error).toContain('tools.json');
    } finally {
      await server?.kill();
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('local plugin with missing dist/adapter.iife.js appears in failedPlugins', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-noiife-'));

    // Create a plugin directory with package.json and tools.json but no adapter IIFE
    const pluginDir = path.join(tmpDir, 'broken-no-iife');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-broken-no-iife',
        version: '0.0.1',
        type: 'module',
        main: 'dist/adapter.iife.js',
        opentabs: {
          displayName: 'Broken No IIFE',
          description: 'Plugin with missing adapter',
          urlPatterns: ['http://localhost/*'],
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, 'dist', 'tools.json'),
      JSON.stringify({ tools: [], resources: [], prompts: [] }),
    );
    // Intentionally NOT writing dist/adapter.iife.js

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-noiife-cfg-'));
    const config = configWithPlugins([path.resolve(pluginDir)]);
    writeTestConfig(configDir, config);

    let server: McpServer | undefined;
    try {
      server = await startMcpServer(configDir, true);
      await server.waitForHealth(h => h.status === 'ok');

      const raw = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await raw.json()) as {
        failedPlugins: Array<{ path: string; error: string }>;
      };

      const failure = body.failedPlugins.find(f => f.path.includes('broken-no-iife'));
      expect(failure).toBeDefined();
      expect(failure?.error).toContain('Adapter IIFE');
    } finally {
      await server?.kill();
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('valid plugins still load when one plugin in localPlugins is broken', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-partial-'));

    // Create a broken plugin (missing tools.json)
    const brokenDir = path.join(tmpDir, 'broken-partial');
    fs.mkdirSync(path.join(brokenDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(brokenDir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-broken-partial',
        version: '0.0.1',
        type: 'module',
        main: 'dist/adapter.iife.js',
        opentabs: {
          displayName: 'Broken Partial',
          description: 'Plugin with missing tools.json for partial load test',
          urlPatterns: ['http://localhost/*'],
        },
      }),
    );
    fs.writeFileSync(path.join(brokenDir, 'dist', 'adapter.iife.js'), '(function(){})();');
    // No tools.json

    // Create a second valid minimal plugin
    const validDir = createMinimalPlugin(tmpDir, 'valid-partial', [{ name: 'ping', description: 'A ping tool' }]);

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-partial-cfg-'));
    const config = configWithPlugins([path.resolve(brokenDir), validDir], {
      'valid-partial_ping': true,
    });
    writeTestConfig(configDir, config);

    let server: McpServer | undefined;
    let client: McpClient | undefined;
    try {
      server = await startMcpServer(configDir, true);
      client = createMcpClient(server.port, server.secret);
      await client.initialize();

      const health = await server.waitForHealth(h => h.status === 'ok');

      // The broken plugin should be in failedPlugins
      const raw = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await raw.json()) as {
        failedPlugins: Array<{ path: string; error: string }>;
      };
      const failure = body.failedPlugins.find(f => f.path.includes('broken-partial'));
      expect(failure).toBeDefined();

      // The valid e2e-test plugin should still be loaded
      expect(health.pluginDetails).toBeDefined();
      const e2ePlugin = health.pluginDetails?.find(p => p.name === 'e2e-test');
      expect(e2ePlugin).toBeDefined();

      // The second valid plugin should also be loaded
      const validPlugin = health.pluginDetails?.find(p => p.name === 'valid-partial');
      expect(validPlugin).toBeDefined();
      expect(validPlugin?.toolCount).toBe(1);

      // Verify tools/list includes tools from both valid plugins
      const tools = await client.listTools();
      expect(tools.some(t => t.name.startsWith('e2e-test_'))).toBe(true);
      expect(tools.some(t => t.name === 'valid-partial_ping')).toBe(true);
    } finally {
      await client?.close();
      await server?.kill();
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('fixing a broken plugin and calling POST /reload transitions it from failedPlugins to healthy', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-fix-'));

    // Create a plugin that starts broken (missing tools.json)
    const pluginDir = path.join(tmpDir, 'fixable');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'opentabs-plugin-fixable',
        version: '0.0.1',
        type: 'module',
        main: 'dist/adapter.iife.js',
        opentabs: {
          displayName: 'Fixable Plugin',
          description: 'Plugin that starts broken then gets fixed',
          urlPatterns: ['http://localhost/*'],
        },
      }),
    );
    fs.writeFileSync(path.join(pluginDir, 'dist', 'adapter.iife.js'), '(function(){})();');
    // Intentionally NOT writing dist/tools.json yet

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-disc-fix-cfg-'));
    const config = configWithPlugins([path.resolve(pluginDir)], { fixable_hello: true });
    writeTestConfig(configDir, config);

    let server: McpServer | undefined;
    let client: McpClient | undefined;
    try {
      server = await startMcpServer(configDir, true);
      client = createMcpClient(server.port, server.secret);
      await client.initialize();
      await server.waitForHealth(h => h.status === 'ok');

      // Verify the plugin is in failedPlugins initially
      const rawBefore = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      const bodyBefore = (await rawBefore.json()) as {
        failedPlugins: Array<{ path: string; error: string }>;
      };
      const failureBefore = bodyBefore.failedPlugins.find(f => f.path.includes('fixable'));
      expect(failureBefore).toBeDefined();

      // "Fix" the plugin by writing a valid tools.json
      fs.writeFileSync(
        path.join(pluginDir, 'dist', 'tools.json'),
        JSON.stringify({
          tools: [
            {
              name: 'hello',
              displayName: 'Hello',
              description: 'A hello tool',
              icon: 'wrench',
              input_schema: { type: 'object', properties: {}, additionalProperties: false },
              output_schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
              },
            },
          ],
          resources: [],
          prompts: [],
        }),
      );

      // Replace the no-op adapter with one that registers properly
      const iife = [
        '(function() {',
        '  if (!globalThis.__openTabs) globalThis.__openTabs = { adapters: {} };',
        '  globalThis.__openTabs.adapters["fixable"] = {',
        '    isReady: function() { return false; },',
        '    tools: {}',
        '  };',
        '})();',
      ].join('\n');
      fs.writeFileSync(path.join(pluginDir, 'dist', 'adapter.iife.js'), iife);

      // Trigger rediscovery via POST /reload
      const reloadRes = await fetch(`http://localhost:${String(server.port)}/reload`, {
        method: 'POST',
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      expect(reloadRes.ok).toBe(true);

      // Wait for the health endpoint to reflect the fixed plugin
      const healthAfter = await server.waitForHealth(h => {
        const fixablePlugin = h.pluginDetails?.find(p => p.name === 'fixable');
        return fixablePlugin !== undefined;
      }, 15_000);

      // Verify the fixable plugin is now in pluginDetails (not failedPlugins)
      const fixablePlugin = healthAfter.pluginDetails?.find(p => p.name === 'fixable');
      expect(fixablePlugin).toBeDefined();
      expect(fixablePlugin?.toolCount).toBe(1);
      expect(fixablePlugin?.displayName).toBe('Fixable Plugin');

      // Verify it's no longer in failedPlugins
      const rawAfter = await fetch(`http://localhost:${String(server.port)}/health`, {
        headers: server.secret ? { Authorization: `Bearer ${server.secret}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      const bodyAfter = (await rawAfter.json()) as {
        failedPlugins: Array<{ path: string; error: string }>;
      };
      const failureAfter = bodyAfter.failedPlugins.find(f => f.path.includes('fixable'));
      expect(failureAfter).toBeUndefined();

      // Verify the tool is now visible in tools/list
      const tools = await client.listTools();
      expect(tools.some(t => t.name === 'fixable_hello')).toBe(true);
    } finally {
      await client?.close();
      await server?.kill();
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
