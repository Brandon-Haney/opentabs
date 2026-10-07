/**
 * Server-side reads of the local files a plugin tool call names.
 *
 * A plugin marks a string input field with `format: LOCAL_FILE_PATH_FORMAT`.
 * Before dispatch, the server collects the values the caller passed in those
 * fields, reads each file, and sends the bytes to the extension with that one
 * dispatch. The read is driven by the tool call alone — the page has no way to
 * request a file — so only paths an MCP client passed to a tool that declares
 * them ever leave the disk.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { getConfigDir, LOCAL_FILE_PATH_FORMAT, type LocalFile, MAX_LOCAL_FILE_BYTES } from '@opentabs-dev/shared';

/** MIME types for common document, image and archive extensions. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.7z': 'application/x-7z-compressed',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eml': 'message/rfc822',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.msg': 'application/vnd.ms-outlook',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.vsdx': 'application/vnd.ms-visio.drawing',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

/** MIME type for a file name, from its extension. */
export const contentTypeFor = (fileName: string): string =>
  CONTENT_TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream';

const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The string values in `value` that sit at a node of `schema` declared with
 * `format: LOCAL_FILE_PATH_FORMAT`, in order of first appearance. Walks object
 * properties, array items and every `anyOf`/`oneOf`/`allOf` branch, so optional,
 * nullable and nested fields are all found.
 */
export const collectLocalFilePaths = (schema: unknown, value: unknown): string[] => {
  const paths = new Set<string>();
  const walk = (node: unknown, data: unknown): void => {
    if (!isSchemaObject(node)) return;
    if (node.format === LOCAL_FILE_PATH_FORMAT && typeof data === 'string') paths.add(data);
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[key];
      if (Array.isArray(branches)) for (const branch of branches) walk(branch, data);
    }
    if (Array.isArray(data)) {
      for (const item of data) walk(node.items, item);
    } else if (isSchemaObject(data) && isSchemaObject(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        if (key in data) walk(child, data[key]);
      }
    }
  };
  walk(schema, value);
  return [...paths];
};

/** A Git Bash / MSYS drive path such as `/c/Users/me/file.pdf`. */
const MSYS_DRIVE_PATH = /^\/([a-zA-Z])(\/.*)?$/;

/**
 * The absolute file-system path a caller meant. On Windows a Git Bash style
 * `/c/...` path names drive C:, which Node would otherwise resolve to `\c\...`
 * on the current drive.
 */
export const resolveCallerPath = (path: string, platform: NodeJS.Platform = process.platform): string => {
  const msys = platform === 'win32' ? MSYS_DRIVE_PATH.exec(path) : null;
  if (msys) return resolve(`${msys[1]?.toUpperCase()}:${msys[2] ?? '/'}`);
  return resolve(path);
};

/** Whether `path` is `dir` or lies inside it. */
const isWithin = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const formatMegabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Outcome of reading the files a tool call names: the files keyed by the caller's path, or why one failed. */
export type LocalFileReadResult = { ok: true; files: Record<string, LocalFile> } | { ok: false; error: string };

/**
 * Read each path as a regular file. Paths must be absolute, must not point into
 * the OpenTabs config directory (it holds the extension's WebSocket secret), and
 * together may total at most MAX_LOCAL_FILE_BYTES.
 */
export const readLocalFiles = async (paths: readonly string[]): Promise<LocalFileReadResult> => {
  const files: Record<string, LocalFile> = {};
  const configDir = await realpath(getConfigDir()).catch(() => resolve(getConfigDir()));
  let totalBytes = 0;

  for (const path of paths) {
    const trimmed = path.trim();
    if (!isAbsolute(trimmed) && !MSYS_DRIVE_PATH.test(trimmed)) {
      return { ok: false, error: `File path "${path}" must be absolute.` };
    }
    let resolved: string;
    let size: number;
    try {
      // The real path, so a link cannot lead into the config directory unnoticed.
      resolved = await realpath(resolveCallerPath(trimmed));
      const stats = await stat(resolved);
      if (!stats.isFile()) return { ok: false, error: `"${path}" is not a file.` };
      size = stats.size;
    } catch {
      return { ok: false, error: `File "${path}" was not found.` };
    }
    if (isWithin(resolved, configDir)) {
      return { ok: false, error: `File "${path}" is inside the OpenTabs config directory and cannot be read.` };
    }

    totalBytes += size;
    if (totalBytes > MAX_LOCAL_FILE_BYTES) {
      return {
        ok: false,
        error: `Local files in one call may total at most ${formatMegabytes(MAX_LOCAL_FILE_BYTES)}; "${path}" brings the total to ${formatMegabytes(totalBytes)}.`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(resolved);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, error: `File "${path}" could not be read${code ? ` (${code})` : ''}.` };
    }
    const name = basename(resolved);
    files[path] = {
      name,
      size: bytes.length,
      contentType: contentTypeFor(name),
      contentBase64: bytes.toString('base64'),
    };
  }

  return { ok: true, files };
};
