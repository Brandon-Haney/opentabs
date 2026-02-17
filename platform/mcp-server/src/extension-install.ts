/**
 * Managed extension auto-install.
 *
 * On every MCP server startup (and hot reload), checks whether the browser
 * extension in ~/.opentabs/extension/ is up to date with the server's package
 * version. If the version file is missing or stale, copies the extension from
 * the platform/browser-extension/ source directory, writes a version marker,
 * and creates the adapters/ directory for plugin IIFEs.
 *
 * The copy excludes build/development artifacts (node_modules, src, .git,
 * tsconfig*) — only the files needed to load an unpacked extension in Chrome.
 */

import { getAdaptersDir, getExtensionDir, getExtensionVersionFile } from './config.js';
import { log } from './logger.js';
import { version } from './version.js';
import { EXTENSION_COPY_EXCLUDE_PATTERN } from '@opentabs-dev/shared';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the browser-extension source directory relative to this module's
 * compiled location. The MCP server compiles to dist/extension-install.js,
 * so browser-extension is at ../../browser-extension from that file.
 */
const getExtensionSourceDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'browser-extension');

/**
 * Ensure the managed extension in ~/.opentabs/extension/ matches the current
 * server version. Copies the extension source if the version is missing or
 * outdated, creating the directory structure as needed.
 *
 * Safe to call on every reload — skips the copy when versions match.
 */
const ensureExtensionInstalled = async (): Promise<void> => {
  const extensionDir = getExtensionDir();
  const versionFile = getExtensionVersionFile();
  const adaptersDir = getAdaptersDir();

  // Read installed version (missing file → empty string → mismatch)
  let installedVersion = '';
  try {
    const file = Bun.file(versionFile);
    if (await file.exists()) {
      installedVersion = (await file.text()).trim();
    }
  } catch {
    // File unreadable — treat as missing
  }

  if (installedVersion === version) {
    log.debug(`Managed extension is up to date (v${version})`);
    return;
  }

  // Version mismatch or missing — perform the copy
  const extensionSrc = getExtensionSourceDir();

  // Verify the source exists before attempting the copy
  if (!(await Bun.file(join(extensionSrc, 'manifest.json')).exists())) {
    log.warn(`Browser extension source not found at ${extensionSrc}, skipping auto-install`);
    return;
  }

  log.info(
    installedVersion
      ? `Updating managed extension: v${installedVersion} → v${version}`
      : `Installing managed extension v${version}`,
  );

  try {
    cpSync(extensionSrc, extensionDir, {
      recursive: true,
      force: true,
      filter: (source: string) => {
        const rel = relative(extensionSrc, source);
        return rel === '' || !EXTENSION_COPY_EXCLUDE_PATTERN.test(rel);
      },
    });

    mkdirSync(adaptersDir, { recursive: true });
    await Bun.write(versionFile, version);

    log.info(`Managed extension installed to ${extensionDir}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to install managed extension: ${msg}`);
  }
};

export { ensureExtensionInstalled };
