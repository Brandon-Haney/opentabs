/**
 * `opentabs dev` command — starts the MCP server with hot reload.
 *
 * Server output is written to both the terminal and a log file at
 * ~/.opentabs/server.log (or $OPENTABS_CONFIG_DIR/server.log).
 * The `opentabs logs` command tails this file.
 */

import { getConfigDir, getLogFilePath } from '../config.js';
import { parsePort, resolvePort } from '../parse-port.js';
import { InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import { mkdirSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { WriteStream } from 'node:fs';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

interface DevOptions {
  port?: number;
  logLevel?: string;
  verbose?: boolean;
}

const resolveServerEntry = (): string => {
  try {
    return fileURLToPath(import.meta.resolve('@opentabs-dev/mcp-server'));
  } catch {
    const cliDir = dirname(fileURLToPath(import.meta.url));
    return resolve(cliDir, '..', '..', '..', 'mcp-server', 'dist', 'index.js');
  }
};

const isPortInUse = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Pipe a readable stream to both a terminal writable and a log file stream.
 * Returns when the readable stream ends.
 */
const teeStream = async (
  readable: ReadableStream<Uint8Array>,
  terminal: NodeJS.WriteStream,
  logFile: WriteStream,
): Promise<void> => {
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    terminal.write(value);
    logFile.write(value);
  }
};

const handleDev = async (options: DevOptions): Promise<void> => {
  const serverEntry = resolveServerEntry();

  if (!(await Bun.file(serverEntry).exists())) {
    console.error(pc.red(`Error: MCP server entry not found at ${serverEntry}`));
    console.error('Run bun run build from the project root first.');
    process.exit(1);
  }

  const port = resolvePort(options);

  if (await isPortInUse(port)) {
    console.error(pc.red(`Error: Port ${port} is already in use.`));
    console.error(
      port === 9515
        ? 'Another OpenTabs server may already be running. Use --port to specify a different port.'
        : `Use a different port with: opentabs dev --port <number>`,
    );
    process.exit(1);
  }

  const env: Record<string, string | undefined> = { ...process.env };
  env.PORT = String(port);
  if (options.verbose) env.OPENTABS_LOG_LEVEL = 'debug';
  else if (options.logLevel) env.OPENTABS_LOG_LEVEL = options.logLevel;

  const logFilePath = getLogFilePath();
  mkdirSync(getConfigDir(), { recursive: true });
  const logStream = createWriteStream(logFilePath, { flags: 'a' });

  console.log(`Starting OpenTabs MCP server on port ${pc.bold(String(port))}...`);
  console.log('');
  console.log(`  ${pc.cyan('MCP endpoint:')}  http://localhost:${port}/mcp`);
  console.log(`  ${pc.cyan('Health check:')}  http://localhost:${port}/health`);
  console.log(`  ${pc.cyan('Log file:')}     ${logFilePath}`);
  console.log('');
  console.log(pc.dim('  MCP client config (~/.claude/settings/mcp.json):'));
  console.log(
    pc.dim(`  { "mcpServers": { "opentabs": { "type": "streamable-http", "url": "http://127.0.0.1:${port}/mcp" } } }`),
  );
  console.log('');
  if (options.verbose) console.log(pc.yellow('  Debug logging enabled'));
  console.log(pc.dim('  Press Ctrl+C to stop'));
  console.log('');

  const proc = Bun.spawn(['bun', '--hot', serverEntry], {
    env: env as Record<string, string>,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const stdoutPipe = teeStream(proc.stdout, process.stdout, logStream);
  const stderrPipe = teeStream(proc.stderr, process.stderr, logStream);

  process.on('SIGINT', () => proc.kill('SIGINT'));
  process.on('SIGTERM', () => proc.kill('SIGTERM'));

  await Promise.all([stdoutPipe, stderrPipe]);
  logStream.end();

  const exitCode = await proc.exited;
  process.exit(exitCode);
};

export const registerDevCommand = (program: Command): void => {
  program
    .command('dev')
    .description('Start the MCP server with hot reload')
    .option('--port <number>', 'Server port (default: 9515)', parsePort)
    .option('--verbose', 'Enable debug logging (shorthand for --log-level debug)')
    .option('--log-level <level>', 'Set log level', (value: string) => {
      if (!(LOG_LEVELS as readonly string[]).includes(value)) {
        throw new InvalidArgumentError(`Must be one of: ${LOG_LEVELS.join(', ')}`);
      }
      return value;
    })
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs dev
  $ opentabs dev --port 3000
  $ opentabs dev --verbose
  $ opentabs dev --log-level warn`,
    )
    .action((_options: DevOptions, command: Command) => {
      const opts = command.optsWithGlobals();
      if (opts.verbose && opts.logLevel) {
        console.error(pc.red('Error: --verbose and --log-level cannot be used together.'));
        console.error('Use --verbose for debug logging, or --log-level to set a specific level.');
        process.exit(1);
      }
      return handleDev(opts);
    });
};
