/**
 * Verifies that no plugin in this repo ships a tool description over the length
 * the MCP server accepts.
 *
 * The server rejects a whole plugin manifest over one long description and falls
 * back to a previously published copy of that plugin, so every tool in it
 * silently stops reflecting local changes — a failure that looks like "my tool
 * vanished" rather than like a validation error.
 *
 * `opentabs-plugin build` already refuses this, but plugins build against the
 * *published* `@opentabs-dev/plugin-tools` rather than the copy in this repo, so
 * that guard does not reach a plugin until the package is published and the
 * plugin's dependency bumped. This check runs from the monorepo against the built
 * manifests, so it holds regardless of which plugin-tools version a plugin has
 * installed.
 *
 * Reads `dist/tools.json`, so it needs the plugins built first — which is why it
 * runs after `build:plugins` in the root `check` script.
 *
 * Usage: tsx scripts/check-tool-descriptions.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MAX_TOOL_DESCRIPTION_LENGTH, TOOLS_FILENAME } from '@opentabs-dev/shared';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGINS_DIR = join(ROOT, 'plugins');

interface ManifestTool {
  name: string;
  description: string;
}

const errors: string[] = [];
let checked = 0;
let plugins = 0;

for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(PLUGINS_DIR, entry.name, 'dist', TOOLS_FILENAME);
  // A plugin that has never been built has nothing to check. Treating that as a
  // failure would make the check depend on build order rather than on content.
  if (!existsSync(manifestPath)) continue;

  plugins += 1;
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestTool[] | { tools?: ManifestTool[] };
  const tools = Array.isArray(parsed) ? parsed : (parsed.tools ?? []);

  for (const tool of tools) {
    checked += 1;
    if (tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
      errors.push(
        `${entry.name}/${tool.name}: ${tool.description.length} characters, ` +
          `${tool.description.length - MAX_TOOL_DESCRIPTION_LENGTH} over the ${MAX_TOOL_DESCRIPTION_LENGTH} limit`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error('Tool description length check failed:');
  for (const err of errors) console.error(`  - ${err}`);
  console.error(
    '\nThe MCP server rejects the entire plugin over this and serves a previously published copy instead,' +
      '\nso every tool in that plugin silently stops reflecting local changes. Shorten the descriptions.' +
      '\nDetail that only matters once a call has failed belongs in the error message, not the description.',
  );
  process.exit(1);
}

console.log(`Tool descriptions within limit: ${checked} tools across ${plugins} built plugins`);
