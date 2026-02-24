/**
 * Build script for the side panel React app.
 * Uses esbuild to bundle React + JSX into a single file for the Chrome extension.
 */

import { build } from 'esbuild';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

const base = import.meta.dirname;
const outdir = join(base, 'dist/side-panel');
const outfile = join(outdir, 'side-panel.js');

// Remove previous bundle to guarantee no stale output survives
await unlink(outfile).catch(() => {});

await build({
  entryPoints: [join(base, 'src/side-panel/index.tsx')],
  outfile,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  minify: false,
  // Some dependencies (e.g., lucide-react/dynamic) expose bare .mjs subpath files
  // without a package.json "exports" map. esbuild needs .mjs in its resolve extensions
  // to find these files.
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

console.log('[opentabs:build:side-panel] Built successfully');
