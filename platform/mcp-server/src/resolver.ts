/**
 * Plugin resolver module.
 *
 * Resolves plugin specifiers (npm package names or filesystem paths) into
 * absolute directory paths containing a plugin's package.json. Decouples
 * path resolution from plugin loading so each phase can be tested independently.
 */

import { ok, err } from '@opentabs-dev/shared';
import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Result } from '@opentabs-dev/shared';

/**
 * Allowed root directories for local plugin paths.
 * Plugins must reside under the user's home directory or the system temp directory.
 * The temp directory allowance supports E2E tests and development workflows.
 */
const getAllowedRoots = (): string[] => [homedir(), tmpdir()];

/**
 * Resolve a path to its canonical form, following symlinks.
 * Falls back to the input path if realpath fails (e.g., non-existent target).
 */
const safeRealpath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * Validate that a resolved plugin path is under an allowed root directory.
 * Uses realpath on both the plugin path and the allowed roots to resolve
 * symlinks (e.g., macOS /var → /private/var), preventing traversal attacks.
 * Checks against both raw and resolved roots to handle non-existent paths
 * where realpath falls back to the unresolved input.
 */
const isAllowedPluginPath = async (resolvedPath: string): Promise<boolean> => {
  const realPath = await safeRealpath(resolvedPath);
  const rawRoots = getAllowedRoots();
  const realRoots = await Promise.all(rawRoots.map(safeRealpath));

  // Deduplicate: on macOS, raw /var/... and resolved /private/var/... differ
  const allRoots = [...new Set([...rawRoots, ...realRoots])];
  return allRoots.some(root => realPath.startsWith(root + '/') || realPath === root);
};

/**
 * Check if a specifier is a local filesystem path.
 * Local paths start with './', '../', '/', or '~/' — everything else is
 * treated as an npm package name.
 */
const isLocalPath = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/') || specifier.startsWith('~/');

/**
 * Resolve a local filesystem path specifier to an absolute directory path.
 * Paths starting with '~/' are expanded to the user's home directory.
 * Other relative paths are resolved against configDir.
 */
const resolveLocalPath = (specifier: string, configDir: string): string => {
  if (specifier.startsWith('~/')) {
    return resolve(homedir(), specifier.slice(2));
  }
  return resolve(configDir, specifier);
};

/**
 * Resolve an npm package specifier to the directory containing its package.json.
 * Uses Bun.resolveSync to locate the package's package.json, then returns
 * the containing directory.
 */
const resolveNpmPackage = (specifier: string): Result<string, string> => {
  try {
    const resolved = Bun.resolveSync(`${specifier}/package.json`, process.cwd());
    return ok(dirname(resolved));
  } catch {
    return err(`Package not found: ${specifier}`);
  }
};

/**
 * Resolve a plugin specifier to an absolute directory path.
 *
 * Specifiers can be:
 * - Local paths: './my-plugin', '../plugins/foo', '/absolute/path', '~/plugins/foo'
 * - npm package names: 'opentabs-plugin-slack', '@org/opentabs-plugin-foo'
 *
 * For local paths, resolves relative to configDir and validates the path is
 * under an allowed root directory (homedir or tmpdir).
 *
 * For npm packages, uses Bun.resolveSync to locate the package directory.
 *
 * Returns the directory path containing the plugin's package.json.
 */
const resolvePluginPath = async (specifier: string, configDir: string): Promise<Result<string, string>> => {
  if (isLocalPath(specifier)) {
    const resolvedPath = resolveLocalPath(specifier, configDir);

    if (!(await isAllowedPluginPath(resolvedPath))) {
      return err(`Path outside allowed directories: ${resolvedPath}`);
    }

    // Verify the directory exists before passing to the loader
    try {
      const stats = await stat(resolvedPath);
      if (!stats.isDirectory()) {
        return err(`Path is not a directory: ${resolvedPath}`);
      }
    } catch {
      return err(`Path not found: ${resolvedPath} — check that the directory exists in your config`);
    }

    return ok(resolvedPath);
  }

  return resolveNpmPackage(specifier);
};

export { isAllowedPluginPath, isLocalPath, resolvePluginPath };
