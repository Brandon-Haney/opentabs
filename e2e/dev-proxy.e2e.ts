/**
 * Dev proxy E2E tests — HTTP buffering, timeout, and restart behavior.
 *
 * These tests verify the dev proxy's request buffering and forwarding
 * mechanisms during worker restarts. The proxy buffers incoming HTTP
 * requests via `whenReady()` while the worker is restarting and drains
 * them once the new worker reports ready via IPC.
 *
 * All tests use dynamic ports and isolated config directories.
 */

import {
  test,
  expect,
  startMcpServer,
  createTestConfigDir,
  cleanupTestConfigDir,
  createMcpClient,
  createMinimalPlugin,
  readPluginToolNames,
  readTestConfig,
  writeTestConfig,
} from './fixtures.js';
import { waitForLog, waitForExtensionConnected, waitForToolList, parseToolResult, setupToolTest } from './helpers.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

test.describe('Dev proxy request buffering', () => {
  test('HTTP request during worker restart is buffered and succeeds after drain', async () => {
    const configDir = createTestConfigDir();
    const server = await startMcpServer(configDir, true);

    try {
      // Verify server is healthy before triggering hot reload
      const initialHealth = await server.health();
      expect(initialHealth).not.toBeNull();
      if (!initialHealth) throw new Error('health returned null');
      expect(initialHealth.status).toBe('ok');

      // Clear logs to isolate hot-reload output
      server.logs.length = 0;

      // Trigger hot reload — the proxy kills the old worker and forks a new one.
      // During the restart window, workerPort is null and requests are buffered
      // in the pending[] array via whenReady().
      server.triggerHotReload();

      // Immediately fire a health request BEFORE the worker reports ready.
      // The proxy's whenReady() buffers this request and forwards it once
      // the new worker sends the IPC 'ready' message with its port.
      const headers: Record<string, string> = {};
      if (server.secret) headers['Authorization'] = `Bearer ${server.secret}`;

      const response = await fetch(`http://localhost:${server.port}/health`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      // The request should succeed — the proxy buffered it during the restart
      // window and forwarded it to the new worker after drain.
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { status: string };
      expect(body.status).toBe('ok');

      // Verify the hot reload actually completed (the request wasn't just
      // served by the old worker before it died)
      await waitForLog(server, 'Hot reload complete', 10_000);
    } finally {
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });
});

test.describe('Dev proxy concurrent overlapping reloads', () => {
  test('two rapid SIGUSR1 signals resolve without deadlock or state corruption', async () => {
    const configDir = createTestConfigDir();
    const server = await startMcpServer(configDir, true);

    try {
      // Verify server is healthy before triggering overlapping reloads
      const initialHealth = await server.health();
      expect(initialHealth).not.toBeNull();
      if (!initialHealth) throw new Error('health returned null');
      expect(initialHealth.status).toBe('ok');

      // Create an MCP client and initialize a session to verify tools/list
      const client = createMcpClient(server.port, server.secret);
      await client.initialize();

      // Verify tools are available before the overlapping reloads
      const toolsBefore = await client.listTools();
      const expectedToolNames = readPluginToolNames();
      for (const name of expectedToolNames) {
        expect(toolsBefore.some(t => t.name === name)).toBe(true);
      }

      // Clear logs to isolate hot-reload output
      server.logs.length = 0;

      // Fire two SIGUSR1 signals in rapid succession (< 100ms apart).
      // The first signal calls startWorker(), which kills the current worker
      // and forks child1. The second signal calls startWorker() again, which
      // kills child1 (before it reports ready) and forks child2. The pending[]
      // callbacks from the first restart are still queued and will be drained
      // when child2 sends its 'ready' IPC message.
      server.triggerHotReload();
      server.triggerHotReload();

      // Wait for the final reload to complete. Only the last worker's 'ready'
      // message triggers "Hot reload complete" — the first worker was killed
      // before it could report ready.
      await waitForLog(server, 'Hot reload complete', 15_000);

      // Verify the server is healthy after overlapping reloads
      const healthAfter = await server.health();
      expect(healthAfter).not.toBeNull();
      if (!healthAfter) throw new Error('health returned null after overlapping reloads');
      expect(healthAfter.status).toBe('ok');

      // Verify tools/list still returns the expected tools. The MCP client
      // auto-reinitializes the session after a worker restart (the new worker
      // has no knowledge of the old session).
      const toolsAfter = await client.listTools();
      for (const name of expectedToolNames) {
        expect(toolsAfter.some(t => t.name === name)).toBe(true);
      }

      // Verify no error logs related to process management or state corruption.
      // Look for unexpected error patterns (not normal proxy log messages).
      const errorPatterns = ['ECONNREFUSED', 'deadlock', 'state corruption', 'uncaughtException'];
      const joinedLogs = server.logs.join('\n');
      for (const pattern of errorPatterns) {
        expect(joinedLogs).not.toContain(pattern);
      }

      await client.close();
    } finally {
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });
});

test.describe('Dev proxy graceful shutdown', () => {
  test('SIGTERM kills worker and proxy exits cleanly', async () => {
    const configDir = createTestConfigDir();
    const server = await startMcpServer(configDir, true);

    try {
      // Verify server is healthy before sending SIGTERM
      const initialHealth = await server.health();
      expect(initialHealth).not.toBeNull();
      if (!initialHealth) throw new Error('health returned null');
      expect(initialHealth.status).toBe('ok');

      const port = server.port;
      const proxyPid = server.proc.pid;
      if (proxyPid === undefined) throw new Error('proxy PID is undefined');

      // Find the worker child process before sending SIGTERM so we can
      // verify it is also cleaned up.
      const pgrepOutput = execSync(`pgrep -P ${proxyPid}`, { encoding: 'utf-8' }).trim();
      const workerPids = pgrepOutput
        .split('\n')
        .map(s => Number(s.trim()))
        .filter(n => !Number.isNaN(n) && n > 0);
      expect(workerPids.length).toBeGreaterThan(0);

      // Create a promise that resolves when the proxy process exits.
      // We listen on the ChildProcess 'exit' event directly to capture
      // the exit code and signal.
      const exitPromise = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        server.proc.once('exit', (code, signal) => {
          resolve({ code, signal: signal as string | null });
        });
      });

      // Send SIGTERM directly to the proxy process (not via the fixture's
      // kill() method). The proxy's SIGTERM handler calls worker?.kill('SIGTERM')
      // then process.exit(0).
      process.kill(proxyPid, 'SIGTERM');

      // Wait for the proxy to exit (should be nearly immediate since
      // process.exit(0) is called synchronously in the SIGTERM handler)
      const exitResult = await exitPromise;

      // Verify the proxy exited cleanly. process.exit(0) produces code=0.
      // On some platforms the signal field may also be set.
      expect(exitResult.code === 0 || exitResult.signal === 'SIGTERM').toBe(true);

      // Verify the port is no longer listening — the proxy's HTTP server
      // should be closed. A fetch should fail with ECONNREFUSED.
      const headers: Record<string, string> = {};
      if (server.secret) headers['Authorization'] = `Bearer ${server.secret}`;

      await expect(
        fetch(`http://localhost:${port}/health`, {
          headers,
          signal: AbortSignal.timeout(3_000),
        }),
      ).rejects.toThrow();

      // Verify no orphaned worker processes remain. After the proxy sends
      // SIGTERM to the worker and calls process.exit(0), the worker should
      // also be dead. Give it a brief moment to exit.
      await new Promise(r => setTimeout(r, 500));

      for (const workerPid of workerPids) {
        let alive = true;
        try {
          // process.kill(pid, 0) throws if the process doesn't exist
          process.kill(workerPid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    } finally {
      // The proxy is already dead from SIGTERM, but call kill() defensively
      // in case the test failed before sending SIGTERM. killProcess handles
      // already-exited processes gracefully.
      await server.kill().catch(() => {});
      cleanupTestConfigDir(configDir);
    }
  });
});

test.describe('Dev proxy health during worker restart window', () => {
  test('health returns degraded state during restart, then 200 after worker is ready', async () => {
    const configDir = createTestConfigDir();
    const server = await startMcpServer(configDir, true);

    try {
      // Verify server is healthy before the restart transition
      const initialHealth = await server.health();
      expect(initialHealth).not.toBeNull();
      if (!initialHealth) throw new Error('health returned null');
      expect(initialHealth.status).toBe('ok');

      const proxyPid = server.proc.pid;
      if (proxyPid === undefined) throw new Error('proxy PID is undefined');

      // Find the worker child process. Killing it directly (not via SIGUSR1)
      // lets us control the timing: the proxy detects the death and sets
      // workerPort = null, but during the brief window before the exit handler
      // runs, proxyHttp forwards to the dead port → 502.
      const pgrepOutput = execSync(`pgrep -P ${proxyPid}`, { encoding: 'utf-8' }).trim();
      const workerPids = pgrepOutput
        .split('\n')
        .map(s => Number(s.trim()))
        .filter(n => !Number.isNaN(n) && n > 0);
      expect(workerPids.length).toBeGreaterThan(0);

      // Start a rapid poll loop. We collect all HTTP status codes returned
      // by /health during the transition. An AbortController signals when
      // to stop polling.
      const statusCodes: number[] = [];
      const stopPolling = new AbortController();

      const headers: Record<string, string> = {};
      if (server.secret) headers['Authorization'] = `Bearer ${server.secret}`;

      const pollLoop = (async () => {
        while (!stopPolling.signal.aborted) {
          try {
            const res = await fetch(`http://localhost:${server.port}/health`, {
              headers,
              signal: AbortSignal.timeout(6_000),
            });
            statusCodes.push(res.status);
          } catch {
            // Connection refused or timeout — record as 0 for tracking
            statusCodes.push(0);
          }
          // Tight polling: 10ms between requests to maximize the chance of
          // hitting the window where the worker is dead but workerPort is set
          await new Promise(r => setTimeout(r, 10));
        }
      })();

      // Give the poll loop a moment to start firing requests
      await new Promise(r => setTimeout(r, 50));

      // Kill the worker directly with SIGKILL. The proxy's exit handler fires
      // asynchronously and clears workerPort. Requests arriving between the
      // kill and the exit handler are forwarded to the dead port → 502.
      for (const pid of workerPids) {
        process.kill(pid, 'SIGKILL');
      }

      // Wait for the proxy to detect the worker exit
      await waitForLog(server, 'Worker exited', 5_000);

      // Trigger a hot reload so a new worker starts. Requests that were
      // buffered via whenReady() (after workerPort became null) will be
      // drained once the new worker reports ready.
      server.triggerHotReload();

      // Wait for the new worker to be ready
      await waitForLog(server, 'Hot reload complete', 15_000);

      // Give the poll loop a few more iterations to capture 200s from the
      // new worker, then stop polling.
      await new Promise(r => setTimeout(r, 200));
      stopPolling.abort();
      await pollLoop;

      // Verify at least one poll returned a non-200 status during the
      // transition (502 from forwarding to the dead worker, 503 from
      // whenReady timeout, or 0 from connection failure).
      const nonOk = statusCodes.filter(s => s !== 200);
      expect(nonOk.length).toBeGreaterThan(0);

      // Verify every non-200 is a recognized degraded status
      for (const code of nonOk) {
        expect([0, 502, 503]).toContain(code);
      }

      // Verify the final polls returned 200 (the new worker is healthy)
      const lastFew = statusCodes.slice(-3);
      expect(lastFew.every(s => s === 200)).toBe(true);

      // Confirm the server is fully healthy after the transition
      const finalHealth = await server.health();
      expect(finalHealth).not.toBeNull();
      if (!finalHealth) throw new Error('health returned null after transition');
      expect(finalHealth.status).toBe('ok');
    } finally {
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });
});

test.describe('Dev proxy 503 timeout', () => {
  test('returns 503 when worker is dead and no restart is triggered', async () => {
    const configDir = createTestConfigDir();
    const server = await startMcpServer(configDir, true);

    try {
      // Verify server is healthy before killing the worker
      const initialHealth = await server.health();
      expect(initialHealth).not.toBeNull();
      if (!initialHealth) throw new Error('health returned null');
      expect(initialHealth.status).toBe('ok');

      // Find the worker child process. The proxy (server.proc) forks a worker
      // via child_process.fork(). Use pgrep to find child PIDs of the proxy.
      const proxyPid = server.proc.pid;
      if (proxyPid === undefined) throw new Error('proxy PID is undefined');

      const pgrepOutput = execSync(`pgrep -P ${proxyPid}`, { encoding: 'utf-8' }).trim();
      const workerPids = pgrepOutput
        .split('\n')
        .map(s => Number(s.trim()))
        .filter(n => !Number.isNaN(n) && n > 0);
      expect(workerPids.length).toBeGreaterThan(0);

      // Kill the worker with SIGKILL so it dies immediately. The proxy's exit
      // handler sets worker = null and workerPort = null but does NOT call
      // startWorker() — only SIGUSR1 or file changes trigger a restart.
      for (const pid of workerPids) {
        process.kill(pid, 'SIGKILL');
      }

      // Wait for the proxy to detect the worker exit
      await waitForLog(server, 'Worker exited', 5_000);

      // Send an HTTP request. With no worker running and no restart triggered,
      // the proxy's whenReady() buffers the request for READY_TIMEOUT_MS (5s)
      // then calls the onTimeout callback, returning 503.
      const headers: Record<string, string> = {};
      if (server.secret) headers['Authorization'] = `Bearer ${server.secret}`;

      const start = Date.now();
      const response = await fetch(`http://localhost:${server.port}/health`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const elapsed = Date.now() - start;

      expect(response.status).toBe(503);

      // The 503 should arrive after approximately READY_TIMEOUT_MS (5s).
      // Allow margin for scheduling variance: at least 4s, at most 8s.
      expect(elapsed).toBeGreaterThanOrEqual(4_000);
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });
});

test.describe('POST /reload in non-hot (production) mode', () => {
  test('config rediscovery adds new plugin tools after POST /reload', async () => {
    const configDir = createTestConfigDir();
    const server = await startMcpServer(configDir, false);

    try {
      // Verify server is healthy in non-hot mode
      const initialHealth = await server.health();
      expect(initialHealth).not.toBeNull();
      if (!initialHealth) throw new Error('health returned null');
      expect(initialHealth.status).toBe('ok');

      // Create an MCP client and initialize a session
      const client = createMcpClient(server.port, server.secret);
      await client.initialize();

      // Verify only the e2e-test plugin tools are registered initially
      const toolsBefore = await client.listTools();
      const expectedToolNames = readPluginToolNames();
      for (const name of expectedToolNames) {
        expect(toolsBefore.some(t => t.name === name)).toBe(true);
      }

      // Create a minimal plugin in a temp directory. The plugin has a single
      // tool and is fully discoverable by the MCP server after config reload.
      const pluginName = 'reload-test';
      const pluginDir = createMinimalPlugin(configDir, pluginName, [{ name: 'ping', description: 'Returns pong' }]);

      // Update config.json to include the new plugin in localPlugins and
      // enable its tool in the tools map.
      const config = readTestConfig(configDir);
      config.localPlugins.push(pluginDir);
      config.tools[`${pluginName}_ping`] = true;
      writeTestConfig(configDir, config);

      // Read the auth secret for the Bearer token
      const authPath = `${configDir}/extension/auth.json`;
      const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as { secret?: string };
      const secret = authData.secret ?? '';

      // POST /reload triggers performConfigReload(), which re-reads
      // config.json, discovers the new plugin, and rebuilds the registry.
      const reloadResponse = await fetch(`http://localhost:${server.port}/reload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      });

      expect(reloadResponse.ok).toBe(true);
      const reloadBody = (await reloadResponse.json()) as { ok: boolean; plugins: number };
      expect(reloadBody.ok).toBe(true);
      // The reload should discover at least 2 plugins (e2e-test + reload-test)
      expect(reloadBody.plugins).toBeGreaterThanOrEqual(2);

      // After reload, tools/list should include the new plugin's tool.
      // Use waitForToolList to poll until the tool appears (the MCP server
      // sends a listChanged notification, but the client may need to
      // re-initialize the session first).
      const toolsAfter = await waitForToolList(
        client,
        tools => tools.some(t => t.name === `${pluginName}_ping`),
        10_000,
        300,
        `${pluginName}_ping tool to appear`,
      );

      // Verify the new plugin's tool is present
      expect(toolsAfter.some(t => t.name === `${pluginName}_ping`)).toBe(true);

      // Verify the original e2e-test tools are still present
      for (const name of expectedToolNames) {
        expect(toolsAfter.some(t => t.name === name)).toBe(true);
      }

      await client.close();
    } finally {
      await server.kill();
      cleanupTestConfigDir(configDir);
    }
  });
});

test.describe.serial('Dev proxy SSE mid-stream worker restart', () => {
  test('SSE tool call gets clean error or completes when worker restarts mid-stream', async ({
    mcpServer,
    testServer,
    extensionContext,
    mcpClient,
  }) => {
    test.slow();

    const page = await setupToolTest(mcpServer, testServer, extensionContext, mcpClient);

    try {
      // Baseline: verify the slow_with_progress tool works normally
      const baseline = await mcpClient.callToolWithProgress(
        'e2e-test_slow_with_progress',
        { durationMs: 500, steps: 2 },
        { timeout: 15_000 },
      );
      expect(baseline.isError).toBe(false);
      const baselineOutput = parseToolResult(baseline.content);
      expect(baselineOutput.completed).toBe(true);

      // Start a slow tool call that produces an SSE stream with progress
      // notifications over 5 seconds. The proxy pipes the response via
      // proxyRes.pipe(res) — when the worker dies mid-stream, the pipe
      // breaks and the client receives either a partial/error response
      // or a connection reset.
      const slowCallPromise = mcpClient.callToolWithProgress(
        'e2e-test_slow_with_progress',
        { durationMs: 5_000, steps: 10 },
        { timeout: 30_000 },
      );

      // Wait for the request to reach the worker and start producing
      // progress events, then trigger hot reload. The proxy kills the
      // old worker with SIGTERM, severing the piped SSE connection.
      await new Promise(r => setTimeout(r, 1_000));
      mcpServer.logs.length = 0;
      mcpServer.triggerHotReload();

      // The SSE stream may complete successfully (if the tool finished
      // before the worker was killed) or fail with 502/connection reset
      // (if the pipe was severed mid-stream). Both outcomes are acceptable
      // — the proxy should not hang indefinitely.
      try {
        const slowResult = await slowCallPromise;
        // If it completed, verify the content is valid
        if (!slowResult.isError) {
          const output = parseToolResult(slowResult.content);
          expect(output.completed).toBe(true);
        }
      } catch {
        // 502 Bad Gateway, connection reset, or partial SSE stream — expected
        // when the worker is killed mid-stream. The proxy's proxyRes.pipe(res)
        // connection breaks when the upstream worker dies.
      }

      // Wait for the hot reload to complete
      await waitForLog(mcpServer, 'Hot reload complete', 20_000);

      // Wait for the extension to reconnect to the new worker. The proxy
      // kills old WebSocket connections during restart, so the extension
      // detects the close and reconnects.
      await waitForExtensionConnected(mcpServer, 30_000);

      // Verify subsequent tool calls work after the reload. The MCP client
      // auto-reinitializes the session (new worker has no session memory).
      const afterResult = await mcpClient.callTool('e2e-test_echo', { message: 'after-sse-reload' });
      expect(afterResult.isError).toBe(false);
      const afterOutput = parseToolResult(afterResult.content);
      expect(afterOutput.message).toBe('after-sse-reload');
    } finally {
      await page.close();
    }
  });
});
