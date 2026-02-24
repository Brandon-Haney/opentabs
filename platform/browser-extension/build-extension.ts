/**
 * Bundle the background service worker and offscreen document.
 *
 * Chrome extension module service workers cannot resolve bare module specifiers
 * (e.g., '@opentabs-dev/shared'). The tsc build emits these as-is, so a
 * bundling step is needed to resolve them into self-contained files.
 *
 * Runs AFTER tsc (which produces dist/ with type-checked JS) and BEFORE the
 * extension is loaded into Chrome. Each entry point is bundled into its
 * original dist/ location, overwriting the tsc output.
 */

import { build } from 'esbuild';
import { join } from 'node:path';

const base = import.meta.dirname;

const bgPath = join(base, 'dist/background.js');
const offscreenPath = join(base, 'dist/offscreen/index.js');

const entries = [
  { entrypoint: bgPath, outfile: bgPath, label: 'background' },
  { entrypoint: offscreenPath, outfile: offscreenPath, label: 'offscreen' },
];

let failed = false;

for (const { entrypoint, outfile, label } of entries) {
  try {
    // Bundling resolves bare specifiers (e.g., @opentabs-dev/shared) and
    // relative imports into a single self-contained file.
    // chrome.* APIs are globals — they don't need to be imported/resolved.
    await build({
      entryPoints: [entrypoint],
      outfile,
      bundle: true,
      platform: 'browser',
      format: 'esm',
      minify: false,
      // Write directly to the exact output path, overwriting the tsc-produced file.
      allowOverwrite: true,
    });

    console.log(`[opentabs:build:${label}] Bundled successfully`);
  } catch (error: unknown) {
    console.error(`[opentabs:build:${label}] Bundle failed:`);
    console.error(error);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

export {};
