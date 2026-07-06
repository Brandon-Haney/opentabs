/**
 * Graceful shutdown and crash-safety handlers for the MCP server.
 *
 * Installs SIGTERM and SIGINT handlers that perform orderly cleanup:
 *   1. Reject all pending dispatches immediately (fast error for MCP clients)
 *   2. Reject all pending confirmations (mirrors WebSocket disconnect behavior)
 *   3. Stop periodic session sweep timer
 *   4. Stop file watchers (release OS handles)
 *   5. Close extension WebSocket cleanly (so offscreen document reconnects)
 *   6. Exit the process
 *
 * Also installs process-level crash backstops:
 *   - 'unhandledRejection': logged and swallowed. A missed promise error does
 *     not corrupt process state, so the long-lived server keeps running rather
 *     than exiting on every stray rejection.
 *   - 'uncaughtException': logged, then the process exits via the same graceful
 *     cleanup path. Per Node.js guidance an uncaught exception leaves the
 *     process in an undefined state, so resuming normal operation is unsafe —
 *     but a clean exit (closing connections so the extension reconnects) is far
 *     better than a raw unhandled-error crash with a bare stack trace.
 *
 * The handlers are installed once on first load. They are not re-registered on
 * hot reload (they survive across module re-evaluations because they reference
 * state via the getter closure, not a stale capture).
 *
 * A globalThis flag prevents double-registration if index.ts is re-evaluated.
 */

import { rejectAllPendingConfirmations } from './extension-handlers.js';
import { stopFileWatching } from './file-watcher.js';
import { log } from './logger.js';
import type { ServerState } from './state.js';
import {
  classifyLoadFailures,
  computeErrorRateBucket,
  getSessionId,
  shutdownTelemetry,
  trackEvent,
} from './telemetry.js';

const SHUTDOWN_INSTALLED_KEY = '__opentabs_shutdown_installed__' as const;

/**
 * Install graceful shutdown and crash-safety handlers.
 * Safe to call on every module evaluation — only installs once per process.
 *
 * @param getState - Getter that returns the current ServerState. Using a getter
 *   instead of a direct reference ensures the handler always operates on the
 *   latest state after hot reloads.
 */
const installShutdownHandlers = (getState: () => ServerState): void => {
  if ((globalThis as Record<string, unknown>)[SHUTDOWN_INSTALLED_KEY]) return;
  (globalThis as Record<string, unknown>)[SHUTDOWN_INSTALLED_KEY] = true;

  // Guards against re-entrancy: if cleanup itself throws (and that throw is
  // caught by the uncaughtException handler), we must not recurse into cleanup
  // a second time.
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`Shutting down (${reason})`);
    const state = getState();

    // 1. Reject all pending dispatches so MCP clients get fast errors
    if (state.pendingDispatches.size > 0) {
      log.info(`Rejecting ${state.pendingDispatches.size} pending dispatch(es)`);
      for (const [id, pending] of state.pendingDispatches) {
        state.pendingDispatches.delete(id);
        clearTimeout(pending.timerId);
        pending.reject(new Error('Server shutting down'));
      }
    }

    // 2. Reject all pending confirmations (mirrors WebSocket disconnect behavior)
    rejectAllPendingConfirmations(state);

    // 3. Stop periodic session sweep timer
    if (state.sweepTimerId !== null) {
      clearInterval(state.sweepTimerId);
      state.sweepTimerId = null;
    }

    // 3b. Stop periodic version check timer
    if (state.versionCheckTimerId !== null) {
      clearInterval(state.versionCheckTimerId);
      state.versionCheckTimerId = null;
    }

    // 4. Stop file watchers (release OS handles)
    stopFileWatching(state);

    // 5. Close all extension WebSocket connections cleanly
    for (const [id, conn] of state.extensionConnections) {
      try {
        conn.ws.close(1001, 'Server shutting down');
      } catch {
        // Already closed
      }
      state.extensionConnections.delete(id);
    }

    // 6. Emit server_stopped telemetry event, then flush
    const auditLog = state.auditLog;
    const total = auditLog.length;
    const errors = auditLog.filter(e => !e.success).length;
    trackEvent('server_stopped', {
      session_id: getSessionId(),
      uptime_seconds: Math.round((Date.now() - state.startedAt) / 1000),
      tool_calls_total: total,
      tool_errors_total: errors,
      tool_error_rate_bucket: computeErrorRateBucket(total, errors),
      extension_was_connected: state.hadExtensionConnection,
      peak_concurrent_dispatches: state.peakConcurrentDispatches,
      plugin_load_failures: classifyLoadFailures(state.registry.failures),
    });
    void shutdownTelemetry();

    log.info('Shutdown complete');
    setTimeout(() => process.exit(exitCode), 150);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));

  // An unhandled promise rejection is a missed error path, not process
  // corruption — log it and keep the server running.
  process.on('unhandledRejection', (reason: unknown) => {
    log.error('Unhandled promise rejection:', reason);
  });

  // An uncaught exception leaves the process in an undefined state (Node.js
  // guidance), so resuming normal operation is unsafe. Log the full error and
  // exit via the graceful cleanup path with a non-zero code, closing
  // connections cleanly so the extension reconnects after a restart.
  process.on('uncaughtException', (err: Error) => {
    log.error('Uncaught exception — shutting down:', err);
    shutdown('uncaughtException', 1);
  });
};

export { installShutdownHandlers };
