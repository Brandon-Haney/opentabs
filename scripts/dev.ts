/**
 * Dev orchestrator: runs tsc --build --watch + bun --hot together,
 * and auto-rebuilds/reloads the Chrome extension on source changes.
 *
 * 1. Starts `tsc --build --watch` to incrementally recompile all platform
 *    packages via project references.
 * 2. Waits for tsc's initial compilation to finish (detects the
 *    "Watching for file changes" line in tsc output).
 * 3. Runs the extension build pipeline (bundle + side panel + install).
 * 4. Starts the MCP server via `bun --hot platform/mcp-server/dist/index.js`.
 * 5. Watches extension-related dist directories for tsc output changes and
 *    re-runs the extension pipeline (debounced), then sends a reload signal
 *    to the Chrome extension via the MCP server.
 * 6. Pipes all processes' stdout/stderr with prefixed labels.
 * 7. Cleans up on SIGINT/SIGTERM.
 */

import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FSWatcher } from 'node:fs';

const ROOT = resolve(import.meta.dirname, '..');

type Writable = { write(data: string): boolean };

/**
 * Read a stream line by line, writing each non-empty line with a prefix.
 * Returns a promise that resolves when the stream ends.
 */
const pipeWithPrefix = async (stream: ReadableStream<Uint8Array>, prefix: string, output: Writable): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    partial += decoder.decode(value, { stream: true });
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) {
        output.write(`${prefix} ${line}\n`);
      }
    }
  }

  if (partial.length > 0) {
    output.write(`${prefix} ${partial}\n`);
  }
};

/**
 * Pipe tsc stdout with a prefix, resolving `onReady` when the
 * "Watching for file changes" sentinel is detected. Continues
 * piping after the sentinel for incremental rebuild output.
 */
const pipeTscStdout = async (
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  output: Writable,
  onReady: () => void,
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = '';
  let ready = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    partial += decoder.decode(value, { stream: true });
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) {
        output.write(`${prefix} ${line}\n`);
      }
      if (!ready && line.includes('Watching for file changes')) {
        ready = true;
        onReady();
      }
    }
  }

  if (partial.length > 0) {
    output.write(`${prefix} ${partial}\n`);
  }
};

/**
 * Read the wsSecret from ~/.opentabs/config.json for authenticating
 * with the MCP server's /extension/reload endpoint.
 */
const readWsSecret = async (): Promise<string | null> => {
  try {
    const configPath = join(homedir(), '.opentabs', 'config.json');
    const raw = await Bun.file(configPath).text();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const secret = (parsed as Record<string, unknown>).secret;
      if (typeof secret === 'string') return secret;
    }
  } catch {
    // Config may not exist yet
  }
  return null;
};

/**
 * Run a shell command, streaming stdout/stderr with a prefix.
 * Returns the exit code.
 */
const runWithPrefix = async (cmd: string[], cwd: string, prefix: string): Promise<number> => {
  const proc = Bun.spawn(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  void pipeWithPrefix(proc.stdout, prefix, process.stdout);
  void pipeWithPrefix(proc.stderr, prefix, process.stderr);
  return proc.exited;
};

/**
 * Run the extension build pipeline: bundle background/offscreen,
 * build the side panel (React + Tailwind), and install to ~/.opentabs/extension/.
 */
const buildExtension = async (): Promise<boolean> => {
  const extDir = join(ROOT, 'platform', 'browser-extension');
  const prefix = '[ext]';

  console.log(`${prefix} Rebuilding extension...`);

  const bundleCode = await runWithPrefix(['bun', 'run', 'build:bundle'], extDir, prefix);
  if (bundleCode !== 0) {
    console.error(`${prefix} build:bundle failed (exit ${bundleCode})`);
    return false;
  }

  const sidePanelCode = await runWithPrefix(['bun', 'run', 'build:side-panel'], extDir, prefix);
  if (sidePanelCode !== 0) {
    console.error(`${prefix} build:side-panel failed (exit ${sidePanelCode})`);
    return false;
  }

  const installCode = await runWithPrefix(['bun', 'scripts/install-extension.ts'], ROOT, prefix);
  if (installCode !== 0) {
    console.error(`${prefix} install-extension failed (exit ${installCode})`);
    return false;
  }

  console.log(`${prefix} Extension built and installed.`);
  return true;
};

/**
 * Send a reload signal to the Chrome extension via the MCP server's
 * /extension/reload endpoint. Handles cases where the server is not
 * running or the extension is not connected.
 */
const reloadExtension = async (): Promise<void> => {
  const prefix = '[ext]';
  const port = Bun.env.PORT ?? '9515';
  const url = `http://localhost:${port}/extension/reload`;

  try {
    const secret = await readWsSecret();
    const headers: Record<string, string> = {};
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    }

    const response = await fetch(url, { method: 'POST', headers });

    if (response.ok) {
      console.log(`${prefix} Extension reloaded.`);
    } else if (response.status === 503) {
      console.log(`${prefix} Extension not connected — reload skipped (will pick up changes on next connect).`);
    } else {
      console.warn(`${prefix} Reload request returned ${response.status}: ${await response.text()}`);
    }
  } catch {
    console.warn(`${prefix} MCP server not reachable — extension reload skipped.`);
  }
};

// Track child processes and watchers for cleanup
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const watchers: FSWatcher[] = [];

const cleanup = (): void => {
  for (const w of watchers) {
    w.close();
  }
  for (const child of children) {
    child.kill('SIGTERM');
  }
};

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

// 1. Start tsc --build --watch
console.log('[dev] Starting tsc --build --watch...');
const tsc = Bun.spawn(['bun', 'run', 'tsc', '--build', '--watch'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(tsc);

// 2. Pipe tsc output and wait for initial compilation
const tscReady = new Promise<void>(r => {
  void pipeTscStdout(tsc.stdout, '[tsc]', process.stdout, r);
});
void pipeWithPrefix(tsc.stderr, '[tsc]', process.stderr);

await tscReady;
console.log('[dev] tsc initial compilation complete.');

// 3. Run the extension build pipeline once after initial tsc build
await buildExtension();

// 4. Start MCP server with bun --hot
console.log('[dev] Starting MCP server (bun --hot)...');
const mcp = Bun.spawn(['bun', '--hot', 'platform/mcp-server/dist/index.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(mcp);

// Pipe MCP output
void pipeWithPrefix(mcp.stdout, '[mcp]', process.stdout);
void pipeWithPrefix(mcp.stderr, '[mcp]', process.stderr);

// 5. Watch extension-related dist dirs for tsc output changes.
//    Only browser-extension/dist/ and shared/dist/ trigger the extension pipeline.
//    MCP server dist/ changes are handled by bun --hot automatically.
let extensionRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let extensionBuildInProgress = false;

const DEBOUNCE_MS = 300;

const scheduleExtensionRebuild = (): void => {
  if (extensionRebuildTimer !== null) {
    clearTimeout(extensionRebuildTimer);
  }
  extensionRebuildTimer = setTimeout(() => {
    extensionRebuildTimer = null;
    if (extensionBuildInProgress) {
      // A build is already running — reschedule so the change is not lost
      scheduleExtensionRebuild();
      return;
    }
    extensionBuildInProgress = true;
    void buildExtension()
      .then(async ok => {
        if (ok) await reloadExtension();
      })
      .finally(() => {
        extensionBuildInProgress = false;
      });
  }, DEBOUNCE_MS);
};

const watchDirs = [join(ROOT, 'platform', 'browser-extension', 'dist'), join(ROOT, 'platform', 'shared', 'dist')];

for (const dir of watchDirs) {
  try {
    const w = watch(dir, { recursive: true }, () => {
      scheduleExtensionRebuild();
    });
    watchers.push(w);
    console.log(`[ext] Watching ${dir.replace(ROOT + '/', '')} for changes`);
  } catch {
    console.warn(`[ext] Could not watch ${dir.replace(ROOT + '/', '')} — directory may not exist yet`);
  }
}

// Wait for either process to exit (shouldn't happen in normal operation)
const tscExit = tsc.exited.then(code => ({ process: 'tsc', code }));
const mcpExit = mcp.exited.then(code => ({ process: 'mcp', code }));
const result = await Promise.race([tscExit, mcpExit]);

console.log(`[dev] ${result.process} exited with code ${result.code}`);
cleanup();
process.exit(result.code);
