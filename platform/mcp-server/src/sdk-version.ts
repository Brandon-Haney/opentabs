/**
 * SDK version that the MCP server is built against.
 *
 * Reads the version from platform/plugin-sdk/package.json (resolved relative
 * to this file's location in the monorepo). Used at plugin load time to check
 * SDK compatibility: a plugin's sdkVersion (from its tools.json) must have a
 * major.minor <= the server's SDK major.minor.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let sdkVersion = '0.0.0';

const sdkPkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin-sdk', 'package.json');

try {
  const pkgJson: unknown = JSON.parse(await readFile(sdkPkgPath, 'utf-8'));
  if (pkgJson !== null && typeof pkgJson === 'object' && 'version' in pkgJson && typeof pkgJson.version === 'string') {
    sdkVersion = pkgJson.version;
  }
} catch {
  console.error(
    `[sdk-version] Failed to read ${sdkPkgPath} — falling back to '0.0.0'. All plugins with a declared sdkVersion will fail compatibility checks.`,
  );
}

export { sdkVersion };
