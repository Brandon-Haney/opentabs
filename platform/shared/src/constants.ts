/**
 * Shared constants for the OpenTabs platform.
 *
 * These values are used by multiple packages (MCP server, CLI, plugin-tools,
 * browser-extension). Defining them once here prevents drift and duplication.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Default port for the MCP server (HTTP + WebSocket) */
export const DEFAULT_PORT = 9515;

// ---------------------------------------------------------------------------
// Plugin build artifacts
// ---------------------------------------------------------------------------

/** Filename of the bundled adapter IIFE produced by `opentabs-plugin build` */
export const ADAPTER_FILENAME = 'adapter.iife.js';

/** Filename of the source map for the adapter IIFE */
export const ADAPTER_SOURCE_MAP_FILENAME = 'adapter.iife.js.map';

/** Filename of the tool/resource/prompt manifest produced by `opentabs-plugin build` */
export const TOOLS_FILENAME = 'tools.json';

// ---------------------------------------------------------------------------
// Config directory paths
// ---------------------------------------------------------------------------

/** Returns the config directory path (~/.opentabs or OPENTABS_CONFIG_DIR override).
 *  Re-evaluated on each call so test overrides via OPENTABS_CONFIG_DIR take effect. */
export const getConfigDir = (): string => Bun.env.OPENTABS_CONFIG_DIR || join(homedir(), '.opentabs');

/** Returns the path to config.json inside the config directory. */
export const getConfigPath = (): string => join(getConfigDir(), 'config.json');

/** Returns the managed extension install directory (~/.opentabs/extension/). */
export const getExtensionDir = (): string => join(getConfigDir(), 'extension');

/** Returns the path to the server log file (~/.opentabs/server.log). */
export const getLogFilePath = (): string => join(getConfigDir(), 'server.log');

// ---------------------------------------------------------------------------
// Cryptography
// ---------------------------------------------------------------------------

/** Generate a 256-bit cryptographic random secret as a 64-character hex string. */
export const generateSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};
