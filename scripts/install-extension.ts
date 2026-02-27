/**
 * Copy the built browser extension to the managed install directory
 * (~/.opentabs/extension/). Runs as the final step of `npm run build`
 * to ensure the managed extension stays in sync with the source during
 * development.
 *
 * Preserves the adapters/ directory (plugin adapter IIFEs are written
 * there at runtime by the MCP server and must not be deleted).
 */

import { EXTENSION_COPY_EXCLUDE_PATTERN } from '../platform/shared/dist/index.js';
import { cpSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

const extensionSrc = join(import.meta.dirname, '..', 'platform', 'browser-extension');
const extensionDest = join(homedir(), '.opentabs', 'extension');
const adaptersDir = join(extensionDest, 'adapters');

cpSync(extensionSrc, extensionDest, {
  recursive: true,
  force: true,
  filter: (source: string) => {
    const rel = relative(extensionSrc, source);
    if (rel === '') return true;
    if (EXTENSION_COPY_EXCLUDE_PATTERN.test(rel)) return false;
    // Preserve adapters directory — managed at runtime by the MCP server
    if (rel === 'adapters' || rel.startsWith('adapters/') || rel.startsWith('adapters\\')) return false;
    return true;
  },
});

mkdirSync(adaptersDir, { recursive: true });

console.log(`Extension installed to ${extensionDest}`);
