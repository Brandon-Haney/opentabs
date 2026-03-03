/**
 * Shared port parser and resolver for Commander options.
 */

import { readFileSync } from 'node:fs';
import { DEFAULT_PORT, getConfigPath } from '@opentabs-dev/shared';
import { InvalidArgumentError } from 'commander';
import pc from 'picocolors';

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('Must be an integer between 1 and 65535.');
  }
  return port;
};

/** Cached config port — read once per process. `undefined` = not yet read, `null` = no valid port. */
let cachedConfigPort: number | null | undefined;

/**
 * Reads the port field from config.json synchronously.
 * Returns a valid port number or null if the file is missing, malformed, or has no valid port.
 * Result is cached for the lifetime of the process.
 */
const readConfigPort = (): number | null => {
  if (cachedConfigPort !== undefined) return cachedConfigPort;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const port = (parsed as Record<string, unknown>).port;
      if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
        cachedConfigPort = port;
        return cachedConfigPort;
      }
    }
  } catch {
    // File missing, unreadable, or invalid JSON — no config port
  }
  cachedConfigPort = null;
  return null;
};

/**
 * Resolves the MCP server port from (in priority order):
 * 1. The --port flag (passed via Commander options)
 * 2. The OPENTABS_PORT environment variable
 * 3. The port field from config.json
 * 4. The default port (9515)
 */
const resolvePort = (options: { port?: number }): number => {
  if (options.port !== undefined) return options.port;

  const envPort = process.env.OPENTABS_PORT;
  if (envPort !== undefined) {
    const parsed = Number(envPort);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
    console.error(
      pc.yellow(
        `Warning: OPENTABS_PORT="${envPort}" is invalid (must be 1-65535). Using default port ${DEFAULT_PORT}.`,
      ),
    );
  }

  const configPort = readConfigPort();
  if (configPort !== null) return configPort;

  return DEFAULT_PORT;
};

/** Reset the cached config port (test-only). */
const resetConfigPortCache = (): void => {
  cachedConfigPort = undefined;
};

export { parsePort, resetConfigPortCache, resolvePort };
