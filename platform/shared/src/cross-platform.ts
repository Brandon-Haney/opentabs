/**
 * Cross-platform utilities for the OpenTabs platform.
 *
 * Provides portable abstractions for file operations, process spawning,
 * and platform detection that work correctly on macOS, Linux, and Windows.
 */

import { toErrorMessage } from './error.js';
import { writeFile } from './runtime.js';
import { chmod, rename, unlink } from 'node:fs/promises';

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
 * On Windows, npm is distributed as `npm.cmd` (a cmd wrapper) and bun as
 * `bun.exe`. Process spawning requires the full name on Windows because it
 * does not search PATHEXT the way cmd.exe does.
 *
 * On Unix, the command name is returned unchanged.
 */
export const platformExec = (cmd: string): string => {
  if (!isWindows()) return cmd;
  switch (cmd) {
    case 'npm':
    case 'npx':
    case 'node':
      return `${cmd}.cmd`;
    case 'bun':
    case 'bunx':
      return `${cmd}.exe`;
    default:
      return cmd;
  }
};

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: write to a temporary file in the same directory,
 * optionally set restrictive permissions, then rename over the target.
 *
 * On POSIX, `rename(2)` is atomic — readers never see a partially-written file.
 * On Windows (NTFS), `rename` fails when the target already exists. The
 * fallback deletes the target first, then renames. This creates a brief window
 * where the file does not exist; callers that read this file should retry on
 * ENOENT.
 *
 * @param filePath  — absolute path to the destination file
 * @param content   — file content to write
 * @param mode      — optional POSIX permission mode (e.g., 0o600). Silently
 *                    skipped on Windows with a debug-level warning.
 */
export const atomicWrite = async (filePath: string, content: string, mode?: number): Promise<void> => {
  const tmpPath = filePath + '.tmp';
  try {
    await writeFile(tmpPath, content);

    if (mode !== undefined) {
      await safeChmod(tmpPath, mode);
    }

    if (isWindows()) {
      // NTFS rename does not atomically replace an existing file. Remove the
      // target first, then rename. The unlink may fail with ENOENT if the
      // target does not exist yet — that is fine.
      await unlink(filePath).catch(() => {});
    }

    await rename(tmpPath, filePath);
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
