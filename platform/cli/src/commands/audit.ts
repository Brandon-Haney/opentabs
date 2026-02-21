/**
 * `opentabs audit` command — shows recent tool invocation history.
 */

import { getConfigPath, isConnectionRefused, readConfig } from '../config.js';
import { resolvePort } from '../parse-port.js';
import { InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import type { Command } from 'commander';

interface AuditOptions {
  port?: number;
  limit?: number;
  plugin?: string;
  json?: boolean;
}

interface AuditEntry {
  timestamp: string;
  tool: string;
  plugin: string;
  success: boolean;
  durationMs: number;
  error?: { code: string; message: string; category?: string };
}

const parseLimit = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError('Must be a positive integer.');
  }
  return n;
};

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  const now = new Date();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const time = `${hours}:${minutes}:${seconds}`;

  // Same day — show time only
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }

  // Different day — include date
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day} ${time}`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const handleAudit = async (options: AuditOptions): Promise<void> => {
  const port = resolvePort(options);
  const limit = options.limit ?? 20;

  // Read secret from config
  const configPath = getConfigPath();
  const { config } = await readConfig(configPath);
  const secret = config && typeof config.secret === 'string' ? config.secret : null;

  // Build URL
  const url = new URL(`http://localhost:${port}/audit`);
  url.searchParams.set('limit', String(limit));
  if (options.plugin) url.searchParams.set('plugin', options.plugin);

  try {
    const headers: Record<string, string> = {};
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const res = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(3_000),
    });

    if (res.status === 401) {
      console.error(pc.red('Authentication failed.'));
      console.error(pc.dim('Is the server secret correct? Check ~/.opentabs/config.json'));
      process.exit(1);
    }

    if (!res.ok) {
      console.error(pc.red(`Error: MCP server returned HTTP ${res.status}.`));
      process.exit(1);
    }

    const entries = (await res.json()) as AuditEntry[];

    if (options.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log(pc.dim('No audit entries found.'));
      return;
    }

    // Table output
    const timeCol = 15;
    const toolCol = 30;
    const statusCol = 4;
    const durationCol = 10;

    console.log(
      pc.bold(
        `${'Time'.padEnd(timeCol)}${'Tool'.padEnd(toolCol)}${'OK'.padEnd(statusCol)}${'Duration'.padEnd(durationCol)}`,
      ),
    );
    console.log(pc.dim('─'.repeat(timeCol + toolCol + statusCol + durationCol)));

    for (const entry of entries) {
      const time = formatTimestamp(entry.timestamp).padEnd(timeCol);
      const tool = entry.tool.padEnd(toolCol);
      const status = (entry.success ? pc.green('✓') : pc.red('✗')).padEnd(statusCol);
      const duration = formatDuration(entry.durationMs).padEnd(durationCol);
      console.log(`${time}${tool}${status}${duration}`);
    }
  } catch (err: unknown) {
    const startHint = `Start it with: opentabs start${port !== 9515 ? ` --port ${port}` : ''}`;

    if (isConnectionRefused(err)) {
      console.error(pc.red('MCP server is not running.'));
      console.error(pc.dim(startHint));
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(pc.red(`Error: ${message}`));
      console.error(pc.dim(startHint));
    }

    process.exit(1);
  }
};

const registerAuditCommand = (program: Command): void => {
  program
    .command('audit')
    .description('Show recent tool invocation history')
    .option('--limit <number>', 'Number of entries to show (default: 20)', parseLimit)
    .option('--plugin <name>', 'Filter by plugin name')
    .option('--json', 'Output raw JSON from the audit endpoint')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs audit
  $ opentabs audit --limit 50
  $ opentabs audit --plugin slack
  $ opentabs audit --json`,
    )
    .action((_options: AuditOptions, command: Command) => handleAudit(command.optsWithGlobals()));
};

export { registerAuditCommand };
