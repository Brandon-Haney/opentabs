/**
 * Outdated plugin version check.
 *
 * On startup, queries the npm registry for each npm-installed plugin
 * to check if a newer version is available. Non-blocking — runs in
 * the background and stores results in server state.
 */

import { log } from './logger.js';
import { platformExec, toErrorMessage } from '@opentabs-dev/shared';
import type { ServerState, OutdatedPlugin } from './state.js';

/** Result of checking a single plugin for updates */
type CheckResult = { kind: 'outdated'; entry: OutdatedPlugin } | { kind: 'up-to-date' } | { kind: 'unreachable' };

/**
 * Query the latest published version of a package via `npm view`.
 * Delegates auth to npm itself, which reads ~/.npmrc for tokens —
 * this handles private/scoped packages without manual token management.
 *
 * @param packageName - npm package name (e.g., 'opentabs-plugin-slack' or '@scope/opentabs-plugin-foo')
 * @returns The latest version string, or null on failure
 */
export const fetchLatestVersion = (packageName: string): string | null => {
  try {
    const result = Bun.spawnSync([platformExec('npm'), 'view', packageName, 'version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.exitCode !== 0) {
      log.debug(`npm view failed for ${packageName}: ${result.stderr.toString().trim()}`);
      return null;
    }
    const version = result.stdout.toString().trim();
    return version || null;
  } catch (e: unknown) {
    log.debug(`Failed to fetch latest version for ${packageName}: ${toErrorMessage(e)}`);
    return null;
  }
};

/**
 * Compare two semver version strings (major.minor.patch only).
 * Strips prerelease suffixes (e.g., "1.0.0-beta.1" → [1, 0, 0]) and leading 'v'
 * prefixes so that version strings with hyphens don't produce NaN during parsing.
 *
 * @param current - The currently installed version string
 * @param latest - The latest available version string
 * @returns True if `latest` is strictly newer than `current`
 */
export const isNewer = (current: string, latest: string): boolean => {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map(segment => {
        const hyphen = segment.indexOf('-');
        const numericVersion = Number(hyphen >= 0 ? segment.slice(0, hyphen) : segment);
        return Number.isFinite(numericVersion) ? numericVersion : 0;
      });

  const currentParts = parse(current);
  const latestParts = parse(latest);

  for (let i = 0; i < 3; i++) {
    const currentSegment = currentParts[i] ?? 0;
    const latestSegment = latestParts[i] ?? 0;
    if (latestSegment > currentSegment) return true;
    if (latestSegment < currentSegment) return false;
  }
  return false;
};

/**
 * Check all npm-installed plugins for newer versions on the registry.
 * Runs `npm view` for each plugin sequentially, logs outdated entries,
 * and stores results in `state.outdatedPlugins`. Skips local plugins.
 *
 * @param state - Server state containing the plugin registry and outdatedPlugins target
 */
export const checkForUpdates = (state: ServerState): void => {
  const npmPlugins = Array.from(state.registry.plugins.values()).filter(
    p => p.trustTier !== 'local' && p.npmPackageName,
  );

  if (npmPlugins.length === 0) return;

  log.info(`Checking ${npmPlugins.length} npm plugin(s) for updates...`);

  const results: CheckResult[] = npmPlugins.map(plugin => {
    const pkgName = plugin.npmPackageName;
    if (!pkgName) return { kind: 'unreachable' };

    const latest = fetchLatestVersion(pkgName);
    if (!latest) return { kind: 'unreachable' };

    if (isNewer(plugin.version, latest)) {
      return {
        kind: 'outdated',
        entry: {
          name: pkgName,
          currentVersion: plugin.version,
          latestVersion: latest,
          updateCommand: `npm update -g ${pkgName}`,
        },
      };
    }
    return { kind: 'up-to-date' };
  });

  const outdated: OutdatedPlugin[] = [];
  let unreachableCount = 0;
  for (const result of results) {
    if (result.kind === 'outdated') {
      outdated.push(result.entry);
    } else if (result.kind === 'unreachable') {
      unreachableCount++;
    }
  }

  state.outdatedPlugins = outdated;

  for (const entry of outdated) {
    log.info(`${entry.name}: ${entry.currentVersion} → ${entry.latestVersion} (run: ${entry.updateCommand})`);
  }

  const total = npmPlugins.length;
  if (unreachableCount === total) {
    log.warn('Could not check for plugin updates — npm registry unreachable');
  } else if (unreachableCount > 0 && outdated.length === 0) {
    log.info(
      `Checked ${total - unreachableCount} of ${total} npm plugins for updates (${unreachableCount} unreachable)`,
    );
  } else if (outdated.length === 0) {
    log.info('All npm plugins are up to date');
  }
};
