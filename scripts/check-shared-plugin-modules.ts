/**
 * Verifies that the modules shared between the Microsoft plugins stay in sync.
 *
 * Plugins are standalone packages with no way to import each other, so the
 * Microsoft-specific helpers (front-door error parsing, diagnostics probes,
 * Office reload markers) live as one canonical copy in plugins/outlook/src and
 * are duplicated byte-for-byte into the other plugins that need them. Without
 * this check a fix applied to one copy quietly leaves the others behind.
 *
 * The check fails when:
 *   - a plugin that must carry a copy is missing it, or its bytes differ from
 *     the canonical file;
 *   - a shared module's unit test exists outside plugins/outlook — the copies
 *     are byte-identical, so a single test run in the canonical plugin covers
 *     them all and duplicate test files only drift;
 *   - any plugin still ships src/fetch-with-retry.ts (or its test) — that
 *     interim copy is retired in favour of `fetchWithRetry` exported by
 *     @opentabs-dev/plugin-sdk.
 *
 * Usage: tsx scripts/check-shared-plugin-modules.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGINS_DIR = join(ROOT, 'plugins');

/** Plugin whose src/ holds the canonical copy of every shared module. */
const CANONICAL_PLUGIN = 'outlook';

/** Shared modules, keyed by file name under src/, mapped to the plugins that must carry a byte-identical copy. */
const SHARED_MODULES: ReadonlyMap<string, readonly string[]> = new Map([
  ['microsoft-upstream.ts', ['teams', 'excel-online', 'microsoft-word', 'powerpoint', 'onenote']],
  ['diagnostics.ts', ['teams', 'excel-online', 'microsoft-word', 'powerpoint', 'onenote']],
  ['reload-marker.ts', ['excel-online', 'microsoft-word', 'powerpoint']],
  ['reload-marker-parse.ts', ['excel-online', 'microsoft-word', 'powerpoint']],
  ['token-fingerprint.ts', ['teams', 'excel-online', 'microsoft-word', 'powerpoint', 'onenote']],
]);

/** Unit tests for the shared modules; they may exist only in the canonical plugin. */
const CANONICAL_ONLY_TESTS = [
  'microsoft-upstream.test.ts',
  'diagnostics.test.ts',
  'reload-marker.test.ts',
  'token-fingerprint.test.ts',
];

/** Files superseded by @opentabs-dev/plugin-sdk exports; no plugin may ship them. */
const RETIRED_FILES = ['fetch-with-retry.ts', 'fetch-with-retry.test.ts'];

const sourcePath = (plugin: string, file: string): string => join(PLUGINS_DIR, plugin, 'src', file);
const displayPath = (plugin: string, file: string): string => `plugins/${plugin}/src/${file}`;

const pluginNames = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(PLUGINS_DIR, entry.name, 'package.json')))
  .map(entry => entry.name)
  .sort();

const errors: string[] = [];
let copiesChecked = 0;

for (const [file, copies] of SHARED_MODULES) {
  const canonicalPath = sourcePath(CANONICAL_PLUGIN, file);
  if (!existsSync(canonicalPath)) {
    errors.push(`${displayPath(CANONICAL_PLUGIN, file)}: canonical file is missing`);
    continue;
  }
  const canonical = readFileSync(canonicalPath);

  for (const plugin of copies) {
    copiesChecked += 1;
    const copyPath = sourcePath(plugin, file);
    if (!existsSync(copyPath)) {
      errors.push(`${displayPath(plugin, file)}: missing (copy it from ${displayPath(CANONICAL_PLUGIN, file)})`);
      continue;
    }
    if (!readFileSync(copyPath).equals(canonical)) {
      errors.push(`${displayPath(plugin, file)}: differs from ${displayPath(CANONICAL_PLUGIN, file)}`);
    }
  }
}

for (const plugin of pluginNames) {
  if (plugin !== CANONICAL_PLUGIN) {
    for (const test of CANONICAL_ONLY_TESTS) {
      if (existsSync(sourcePath(plugin, test))) {
        errors.push(`${displayPath(plugin, test)}: shared-module tests live only in plugins/${CANONICAL_PLUGIN}`);
      }
    }
  }
  for (const retired of RETIRED_FILES) {
    if (existsSync(sourcePath(plugin, retired))) {
      errors.push(`${displayPath(plugin, retired)}: retired — import fetchWithRetry from @opentabs-dev/plugin-sdk`);
    }
  }
}

if (errors.length > 0) {
  console.error('Shared plugin module check failed:');
  for (const err of errors) console.error(`  - ${err}`);
  console.error(
    `\nplugins/${CANONICAL_PLUGIN}/src holds the canonical copy of each shared module. Edit it there,` +
      '\nthen copy the file unchanged into every plugin listed for it in scripts/check-shared-plugin-modules.ts.',
  );
  process.exit(1);
}

console.log(
  `Shared plugin modules in sync: ${copiesChecked} copies of ${SHARED_MODULES.size} canonical files, ` +
    `no stray tests or retired files across ${pluginNames.length} plugins`,
);
