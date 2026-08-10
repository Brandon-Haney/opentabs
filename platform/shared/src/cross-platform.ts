/**
 * Cross-platform utilities for the OpenTabs platform.
 *
 * Provides portable abstractions for file operations, process spawning,
 * and platform detection that work correctly on macOS, Linux, and Windows.
 */

import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { toErrorMessage } from './error.js';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Returns true when running on Windows (process.platform === 'win32'). */
export const isWindows = (): boolean => process.platform === 'win32';

// ---------------------------------------------------------------------------
// Command resolution for cross-platform process spawning
// ---------------------------------------------------------------------------

/**
 * Resolves a bare command name for the current platform.
 *
 * @deprecated Use `npmSpawnOpts()` for npm/npx, or `process.execPath` for
 * node. This function appends `.cmd` on Windows but `spawn()` cannot execute
 * `.cmd` files without `shell: true`, so callers must also pass `shell: true`
 * to avoid `EINVAL`. Prefer the dedicated helper instead.
 */
export const platformExec = (cmd: string): string => {
  if (!isWindows()) return cmd;
  switch (cmd) {
    case 'npm':
    case 'npx':
    case 'node':
      return `${cmd}.cmd`;
    default:
      return cmd;
  }
};

/**
 * Returns spawn options shared by every child process on all platforms.
 *
 * On Windows, npm and npx are `.cmd` batch wrappers that require `cmd.exe`
 * to execute. `spawn('npm.cmd', ...)` without `shell: true` fails with
 * `EINVAL`, so `shell` is enabled on Windows.
 *
 * `windowsHide: true` prevents each child from opening its own visible
 * console window on Windows — without it, spawning one process per installed
 * plugin (e.g. the boot-time `npm view` update checks) flashes a burst of
 * console windows. The option is ignored on non-Windows platforms.
 *
 * Usage:
 * ```ts
 * spawn('npm', ['install'], { ...npmSpawnOpts(), stdio: 'inherit' });
 * spawnSync('npm', ['view', pkg, 'version'], { ...npmSpawnOpts(), stdio: 'pipe' });
 * ```
 */
export const npmSpawnOpts = (): { shell: boolean; windowsHide: boolean } => ({
  shell: isWindows(),
  windowsHide: true,
});

// ---------------------------------------------------------------------------
// Environment sanitization
// ---------------------------------------------------------------------------

/**
 * Strip undefined values from an environment object.
 *
 * `process.env` values are `string | undefined`. On Windows, libuv rejects
 * `undefined` values in the `env` option passed to `spawn` / `fork` with
 * `EINVAL`. This helper produces a clean `Record<string, string>` safe for
 * all platforms.
 */
export const sanitizeEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
};

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

/**
 * Errors Windows raises for a rename that lost a race, rather than one that
 * cannot succeed. All three are reported for a target another writer holds
 * open or is itself replacing, and all three clear on their own.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Attempts and spacing for {@link renameReplacing}; ~200ms in the worst case. */
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 20;

/**
 * Rename over the target, retrying the contention errors Windows reports.
 *
 * Only retried on Windows: POSIX `rename(2)` never fails for contention, so
 * there these codes mean a genuine permission or busy-resource problem that
 * retrying would merely delay.
 */
const renameReplacing = async (from: string, to: string): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!isWindows() || attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      await sleep(RENAME_RETRY_MS);
    }
  }
};

/**
 * Write a file atomically: write to a temporary file in the same directory,
 * optionally set restrictive permissions, then rename over the target.
 *
 * The rename replaces the target on every supported platform — `rename(2)` on
 * POSIX, and on Windows libuv issues `MoveFileExW` with
 * `MOVEFILE_REPLACE_EXISTING`. A reader therefore sees either the old file or
 * the new one, never a partial write and never a missing file.
 *
 * Deliberately no unlink-then-rename path for Windows: removing the target
 * first opens a window in which the file does not exist, and buys nothing,
 * since the rename replaces it anyway.
 *
 * The rename is retried, because Windows does not serialise two renames onto
 * the same target — it fails the loser with EPERM instead of making it wait.
 * Measured at 52 failures in 200 concurrent pairs, none of them corrupt. Since
 * several agents write this machine's config at once, that is a routine event
 * rather than a rare one.
 *
 * @param filePath  — absolute path to the destination file
 * @param content   — file content to write
 * @param mode      — optional POSIX permission mode (e.g., 0o600). Silently
 *                    skipped on Windows with a debug-level warning.
 */
export const atomicWrite = async (filePath: string, content: string, mode?: number): Promise<void> => {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmpPath, content, 'utf-8');

    if (mode !== undefined) {
      await safeChmod(tmpPath, mode);
    }

    await renameReplacing(tmpPath, filePath);
  } catch (err) {
    // Clean up the temporary file on any failure.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Set file permissions, silently succeeding on Windows where POSIX chmod
 * is not supported. Logs a warning if chmod fails on a platform that
 * supports it (i.e., on POSIX systems).
 */
export const safeChmod = async (filePath: string, mode: number): Promise<void> => {
  if (isWindows()) {
    // Windows does not support POSIX file permissions.
    return;
  }

  await chmod(filePath, mode).catch((err: unknown) => {
    console.warn(
      `Warning: Could not set file permissions on ${filePath}: ${toErrorMessage(err)}. The file may be readable by other users.`,
    );
  });
};
