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
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    format: 'esm',
    minify: false,
    // Bundling resolves bare specifiers (e.g., @opentabs-dev/shared) and
    // relative imports into a single self-contained file.
    //
    // chrome.* APIs are globals — they don't need to be imported/resolved.
  });

  if (!result.success) {
    console.error(`[${label}] Bundle failed:`);
    for (const log of result.logs) {
      console.error(log);
    }
    failed = true;
    continue;
  }

  // Bun.build writes to outdir (directory-based) — we need to write to the
  // exact output path since we're overwriting the tsc-produced file.
  const output = result.outputs[0];
  if (!output) {
    console.error(`[${label}] Bundle produced no output`);
    failed = true;
    continue;
  }

  await Bun.write(outfile, output);
  console.log(`[${label}] Bundled successfully`);
}

if (failed) {
  process.exit(1);
}

export {};
