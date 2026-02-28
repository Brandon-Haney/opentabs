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

import { test, expect, startMcpServer, createTestConfigDir, cleanupTestConfigDir } from './fixtures.js';
import { waitForLog } from './helpers.js';
import { execSync } from 'node:child_process';

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
