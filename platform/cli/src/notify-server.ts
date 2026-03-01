/**
 * Shared helper to notify the running MCP server via POST /reload.
 * Used by both plugin commands and config set commands.
 */

import { readAuthSecret } from './config.js';
import { resolvePort } from './parse-port.js';
import { DEFAULT_HOST } from '@opentabs-dev/shared';
import pc from 'picocolors';

interface NotifyOptions {
  port?: number;
  /** When true, prints a dim hint when the server is not running. */
  warnIfNotRunning?: boolean;
  /** Custom message to print when the server is successfully reached. Defaults to 'Server notified.' */
  successMessage?: string;
}

/**
 * POST /reload to the running MCP server so it picks up changes.
 * Non-fatal — prints hints on failure but never throws.
 */
const notifyServer = async (options: NotifyOptions): Promise<void> => {
  const port = resolvePort(options);
  const secret = await readAuthSecret();

  try {
    const healthRes = await fetch(`http://${DEFAULT_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    const isOpenTabs = healthRes.headers.get('x-opentabs-version') !== null;
    if (!healthRes.ok || !isOpenTabs) {
      if (options.warnIfNotRunning) {
        console.log(pc.dim('Server not running — changes will apply on next start.'));
      }
      return;
    }
  } catch {
    if (options.warnIfNotRunning) {
      console.log(pc.dim('Server not running — changes will apply on next start.'));
    }
    return;
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const res = await fetch(`http://${DEFAULT_HOST}:${port}/reload`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    if (res.ok) {
      console.log(options.successMessage ?? pc.dim('Server notified.'));
    } else {
      console.log(pc.dim(`Could not notify server (HTTP ${res.status}). Restart the server to pick up changes.`));
    }
  } catch {
    console.log(pc.dim('Could not notify server. Restart the server to pick up changes.'));
  }
};

export { notifyServer };
