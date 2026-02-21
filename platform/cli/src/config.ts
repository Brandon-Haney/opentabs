/**
 * Config file helpers shared across CLI commands.
 */

import { chmod, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';

export const getConfigDir = (): string => Bun.env.OPENTABS_CONFIG_DIR || join(homedir(), '.opentabs');

export const getConfigPath = (): string => join(getConfigDir(), 'config.json');

export const getLogFilePath = (): string => join(getConfigDir(), 'server.log');

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
      message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
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

/**
 * Write config atomically: write to a temp file in the same directory,
 * set restrictive permissions, then rename over the target. The rename
 * is atomic on POSIX filesystems, so readers never see a partially-written file.
 */
export const atomicWriteConfig = async (configPath: string, content: string): Promise<void> => {
  const tmpPath = configPath + '.tmp';
  try {
    await Bun.write(tmpPath, content);
    await chmod(tmpPath, 0o600).catch(() => {});
    await rename(tmpPath, configPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
};

export const isConnectionRefused = (err: unknown): boolean => {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as TypeError & { cause?: { code?: string } }).cause;
  return cause?.code === 'ECONNREFUSED';
};
