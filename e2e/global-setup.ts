/**
 * Playwright global setup — verifies E2E test prerequisites before running tests.
 *
 * Runs once in the main process before any test workers spawn:
 *   1. Checks that the e2e-test plugin has been built (dist/tools.json and
 *      dist/adapter.iife.js exist).
 *   2. Patches dist/tools.json with an sdkVersion field if missing, so
 *      parallel workers don't race on writing the same file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PLUGIN_DIR = resolve('plugins/e2e-test/dist');
const PLUGIN_SDK_PKG_PATH = resolve('platform/plugin-sdk/package.json');
const REQUIRED_FILES = ['tools.json', 'adapter.iife.js'] as const;

/**
 * Ensure the e2e-test plugin's dist/tools.json contains an `sdkVersion` field.
 *
 * The published `@opentabs-dev/plugin-tools` may not yet include the
 * `sdkVersion` feature, so `opentabs-plugin build` can produce a manifest
 * without it. This function patches the manifest so that E2E tests exercising
 * SDK version behavior always have a valid field.
 *
 * Runs once in globalSetup (before workers spawn) to avoid parallel workers
 * racing on the same source-tree file.
 */
const ensureSdkVersionInManifest = (): void => {
  const toolsJsonPath = resolve(PLUGIN_DIR, 'tools.json');
  if (!existsSync(toolsJsonPath)) return;

  const raw = JSON.parse(readFileSync(toolsJsonPath, 'utf-8')) as Record<string, unknown>;
  if (typeof raw.sdkVersion === 'string' && raw.sdkVersion.length > 0) return;

  const sdkPkg = JSON.parse(readFileSync(PLUGIN_SDK_PKG_PATH, 'utf-8')) as { version: string };
  raw.sdkVersion = sdkPkg.version;
  writeFileSync(toolsJsonPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
};

/**
 * Fail fast if OPENTABS_CONFIG_DIR points to the real ~/.opentabs directory.
 * E2E tests must use isolated temp directories — running against the host
 * config would corrupt the user's real configuration.
 */
const assertNotRealConfigDir = (): void => {
  const configDir = process.env.OPENTABS_CONFIG_DIR;
  if (configDir && resolve(configDir) === resolve(join(homedir(), '.opentabs'))) {
    throw new Error(
      'OPENTABS_CONFIG_DIR points to the real ~/.opentabs directory. ' +
        'E2E tests must use isolated config directories to avoid corrupting host configuration.',
    );
  }
};

export default function globalSetup(): void {
  assertNotRealConfigDir();

  const missing = REQUIRED_FILES.filter(file => !existsSync(resolve(PLUGIN_DIR, file)));

  if (missing.length > 0) {
    throw new Error(
      `E2E test plugin not built (missing: ${missing.join(', ')}).\n` +
        'Run: cd plugins/e2e-test && npm install && npm run build',
    );
  }

  ensureSdkVersionInManifest();
}
