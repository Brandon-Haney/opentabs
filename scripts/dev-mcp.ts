/**
 * Wrapper for the dev proxy that checks for the existence of the compiled
 * output before starting. Provides a clear error message if the project
 * hasn't been built yet, instead of a cryptic module resolution failure.
 *
 * Invoked via the "dev:mcp" script in package.json.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const proxyPath = resolve(ROOT, 'platform', 'mcp-server', 'dist', 'dev-proxy.js');

if (!existsSync(proxyPath)) {
  console.error('Error: platform/mcp-server/dist/dev-proxy.js not found.');
  console.error('Run `npm run build` first to compile the project.');
  process.exit(1);
}

const proc = spawn(process.execPath, [proxyPath], {
  stdio: ['inherit', 'inherit', 'inherit'],
});

proc.on('close', code => {
  process.exit(code ?? 0);
});
