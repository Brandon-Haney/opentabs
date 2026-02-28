/**
 * Persistent audit log — appends tool invocations to ~/.opentabs/audit.log as NDJSON.
 *
 * Each line is a self-contained JSON object matching the AuditEntry interface.
 * The file is created with 0600 permissions on first write and rotated when
 * it exceeds 10 MB (audit.log → audit.log.1, keeping at most 1 rotated file).
 *
 * Disk writes are fire-and-forget: errors are logged but never block tool dispatch.
 */

import { getConfigDir } from './config.js';
import { log } from './logger.js';
import { safeChmod, toErrorMessage } from '@opentabs-dev/shared';
import { appendFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEntry } from './state.js';

/** Maximum audit.log size before rotation (10 MB) */
const MAX_AUDIT_FILE_SIZE = 10 * 1024 * 1024;

/** globalThis key for persisting the initialized flag across hot reloads */
const INITIALIZED_KEY = '__opentabs_audit_initialized__' as const;

/** globalThis key for persisting the write counter across hot reloads */
const WRITE_COUNT_KEY = '__opentabs_audit_write_count__' as const;

/** Check rotation every N writes to avoid per-write stat() syscalls */
const ROTATION_CHECK_INTERVAL = 100;

/**
 * Rotate the audit log if it exceeds MAX_AUDIT_FILE_SIZE.
 * Renames audit.log → audit.log.1, deleting any existing audit.log.1 first.
 */
const rotateIfNeeded = async (auditPath: string): Promise<void> => {
  try {
    const stats = await stat(auditPath);
    if (stats.size < MAX_AUDIT_FILE_SIZE) return;

    const rotatedPath = auditPath + '.1';

    // Delete any existing rotated file
    await unlink(rotatedPath).catch(() => {});

    // Rename current → rotated
    await rename(auditPath, rotatedPath);

    log.info(`Rotated audit log (${(stats.size / 1024 / 1024).toFixed(1)} MB) → audit.log.1`);
  } catch (err) {
    // File doesn't exist yet or stat failed — no rotation needed
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn(`Audit log rotation failed: ${toErrorMessage(err)}`);
  }
};

/** Get the path to the audit log file */
const getAuditLogPath = (): string => join(getConfigDir(), 'audit.log');

/**
 * Append an audit entry to the disk-based audit log.
 *
 * Fire-and-forget: errors are caught and logged, never thrown.
 * Rotation is checked once every ROTATION_CHECK_INTERVAL writes to avoid per-write stat() overhead.
 */
const appendAuditEntryToDisk = async (entry: AuditEntry): Promise<void> => {
  try {
    const auditPath = getAuditLogPath();
    const line = JSON.stringify(entry) + '\n';

    const g = globalThis as Record<string, unknown>;
    const count = (g[WRITE_COUNT_KEY] as number | undefined) ?? 0;

    // Rotate if the file exceeds the size limit — checked every ROTATION_CHECK_INTERVAL writes
    if (count % ROTATION_CHECK_INTERVAL === 0) {
      await rotateIfNeeded(auditPath);
    }

    // Increment counter after the rotation check so count=0 always checks on the first write
    g[WRITE_COUNT_KEY] = count + 1;

    // Append the entry
    await appendFile(auditPath, line, { mode: 0o600 });

    // Set permissions on first write this session (survives hot reloads)
    if (!g[INITIALIZED_KEY]) {
      await safeChmod(auditPath, 0o600);
      g[INITIALIZED_KEY] = true;
    }
  } catch (err) {
    log.warn(`Failed to write audit entry to disk: ${toErrorMessage(err)}`);
  }
};

/** Reset initialized state and write counter (for testing) */
const _resetInitialized = (): void => {
  const g = globalThis as Record<string, unknown>;
  g[INITIALIZED_KEY] = false;
  g[WRITE_COUNT_KEY] = 0;
};

export { appendAuditEntryToDisk, getAuditLogPath, _resetInitialized };
