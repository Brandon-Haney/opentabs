/**
 * Runtime compatibility layer for Node.js and Bun.
 *
 * Production code imports these helpers instead of using Bun-specific APIs
 * directly. When running under Bun, the fast native APIs are used. When
 * running under Node.js, equivalent standard library APIs are used.
 *
 * Platform-contributor-only code (tests, build scripts, dev mode) may still
 * use Bun APIs directly since contributors always have Bun installed.
 */

import { spawnSync as nodeSpawnSync, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile as nodeReadFile, writeFile as nodeWriteFile, unlink, stat } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/** True when running under the Bun runtime. */
export const isBun = typeof Bun !== 'undefined';

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Read a file as UTF-8 text. */
export const readFile = async (path: string): Promise<string> => {
  if (isBun) return Bun.file(path).text();
  return nodeReadFile(path, 'utf-8');
};

/** Read a file and parse it as JSON. */
export const readJsonFile = async (path: string): Promise<unknown> => {
  const text = await readFile(path);
  return JSON.parse(text) as unknown;
};

/** Write a string to a file (creates or overwrites). */
export const writeFile = async (path: string, content: string): Promise<void> => {
  if (isBun) {
    await Bun.write(path, content);
    return;
  }
  await nodeWriteFile(path, content, 'utf-8');
};

/** Check whether a file exists. */
export const fileExists = async (path: string): Promise<boolean> => {
  if (isBun) return Bun.file(path).exists();
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Delete a file. Does not throw if the file does not exist. */
export const deleteFile = async (path: string): Promise<void> => {
  if (isBun) {
    await Bun.file(path).delete();
    return;
  }
  await unlink(path).catch(() => {});
};

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

/** Result of a spawned process. */
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options for process spawning. */
export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: 'inherit' | 'pipe' | 'ignore';
}

/** Spawn a process synchronously and return its exit code and output. */
export const spawnProcessSync = (cmd: string, args: string[], opts?: SpawnOptions): SpawnResult => {
  if (isBun) {
    const result = Bun.spawnSync([cmd, ...args], {
      cwd: opts?.cwd,
      env: opts?.env as Record<string, string>,
      stdin: opts?.stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }
  const result = nodeSpawnSync(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env as NodeJS.ProcessEnv,
    stdio: [opts?.stdin ?? 'ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

/** Spawn a process asynchronously and return its exit code and output. */
export const spawnProcess = (cmd: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult> => {
  if (isBun) {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts?.cwd,
      env: opts?.env as Record<string, string>,
      stdin: opts?.stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return proc.exited.then(async exitCode => {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    });
  }
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env as NodeJS.ProcessEnv,
      stdio: [opts?.stdin ?? 'ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      });
    });
  });
};

// ---------------------------------------------------------------------------
// Environment & CLI
// ---------------------------------------------------------------------------

/** Read an environment variable. */
export const getEnv = (name: string): string | undefined => {
  if (isBun) return Bun.env[name];
  return process.env[name];
};

/** Get the command-line arguments (equivalent to process.argv). */
export const getArgv = (): string[] => {
  if (isBun) return Bun.argv;
  return process.argv;
};

// ---------------------------------------------------------------------------
// Cryptography
// ---------------------------------------------------------------------------

/** Compute a SHA-256 hex digest of the given data. */
export const sha256 = (data: string | Uint8Array): string => {
  if (isBun) {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(data);
    return hasher.digest('hex');
  }
  return createHash('sha256').update(data).digest('hex');
};
