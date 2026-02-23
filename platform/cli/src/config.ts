/**
 * Config file helpers shared across CLI commands.
 */

import {
  atomicWrite,
  getConfigDir,
  getConfigPath,
  getExtensionDir,
  getLogFilePath,
  toErrorMessage,
} from '@opentabs-dev/shared';
import { dirname, resolve, isAbsolute } from 'node:path';

export { getConfigDir, getConfigPath, getExtensionDir, getLogFilePath };

export type ConfigResult =
  | { config: Record<string, unknown>; error?: undefined }
  | { config: null; error: 'missing' }
  | { config: null; error: 'invalid'; message: string };

export const readConfig = async (configPath: string): Promise<ConfigResult> => {
  const configFile = Bun.file(configPath);
  if (!(await configFile.exists())) {
    return { config: null, error: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await configFile.text());
  } catch (err) {
    return {
      config: null,
      error: 'invalid',
      message: `Invalid JSON: ${toErrorMessage(err)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? 'array' : String(parsed);
    return {
      config: null,
      error: 'invalid',
      message: `Expected a JSON object, got ${got}`,
    };
  }
  return { config: parsed as Record<string, unknown> };
};

export const getLocalPluginsFromConfig = (config: Record<string, unknown>): string[] =>
  Array.isArray(config.localPlugins)
    ? (config.localPlugins as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];

export const resolvePluginPath = (pluginPath: string, configPath: string): string =>
  isAbsolute(pluginPath) ? pluginPath : resolve(dirname(configPath), pluginPath);

/** Write config atomically with restrictive permissions via the shared helper. */
export const atomicWriteConfig = (configPath: string, content: string): Promise<void> =>
  atomicWrite(configPath, content, 0o600);

export const isConnectionRefused = (err: unknown): boolean => {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as TypeError & { cause?: { code?: string } }).cause;
  return cause?.code === 'ECONNREFUSED';
};
