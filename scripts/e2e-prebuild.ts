/**
 * Build the e2e-test plugin the Playwright suite dispatches tools against.
 *
 * These steps used to be a chain inside the `test:e2e` npm script, written for a
 * POSIX shell: an `rm -f`, a hard-coded `/tmp` path, and a `VAR=value command`
 * prefix. npm runs scripts through cmd.exe on Windows, which parses none of
 * those, so the whole suite was unrunnable there for reasons that had nothing to
 * do with the tests. Node expresses the same three steps portably.
 *
 * Run as part of the test:e2e pipeline:
 *   tsx scripts/e2e-prebuild.ts
 */

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pluginDir = path.join(root, 'plugins', 'e2e-test');

/**
 * An isolated config directory for the build. `opentabs-plugin build` registers
 * the plugin it just built and notifies a running server, so without this the
 * prebuild would edit the developer's real `~/.opentabs/config.json`.
 */
const configDir = path.join(os.tmpdir(), 'opentabs-e2e-prebuild');

execSync('npm ci', { cwd: pluginDir, stdio: 'inherit' });

// tsc skips compilation when its build info says the output is current, which it
// does not know about changes to the platform packages the plugin builds against.
rmSync(path.join(pluginDir, 'tsconfig.tsbuildinfo'), { force: true });

execSync('npm run build', {
  cwd: pluginDir,
  stdio: 'inherit',
  env: { ...process.env, OPENTABS_CONFIG_DIR: configDir },
});
