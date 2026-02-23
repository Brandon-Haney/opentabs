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

/** Whether the audit file has been initialized this session (permissions set) */
let initialized = false;

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
 * Rotation is checked before each write for simplicity.
 */
const appendAuditEntryToDisk = async (entry: AuditEntry): Promise<void> => {
  try {
    const auditPath = getAuditLogPath();
    const line = JSON.stringify(entry) + '\n';

    // Rotate if the file exceeds the size limit
    await rotateIfNeeded(auditPath);

    // Append the entry
    await appendFile(auditPath, line, { mode: 0o600 });

    // Set permissions on first write this session
    if (!initialized) {
      await safeChmod(auditPath, 0o600);
      initialized = true;
    }
  } catch (err) {
    log.warn(`Failed to write audit entry to disk: ${toErrorMessage(err)}`);
  }
};

/** Reset initialized state (for testing) */
const _resetInitialized = (): void => {
  initialized = false;
};

export { appendAuditEntryToDisk, getAuditLogPath, _resetInitialized };
