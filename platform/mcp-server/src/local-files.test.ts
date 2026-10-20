import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCAL_FILE_PATH_FORMAT, MAX_LOCAL_FILE_BYTES, SAVE_FILE_PATH_FORMAT } from '@opentabs-dev/shared';
import { afterAll, describe, expect, test } from 'vitest';
import { collectFilePaths, contentTypeFor, readLocalFiles, resolveCallerPath, writeSavedFiles } from './local-files.js';

const TEST_BASE_DIR = mkdtempSync(join(tmpdir(), 'opentabs-local-files-test-'));
const CONFIG_DIR = join(TEST_BASE_DIR, 'config');
const FILES_DIR = join(TEST_BASE_DIR, 'files');
mkdirSync(CONFIG_DIR);
mkdirSync(FILES_DIR);

// Override OPENTABS_CONFIG_DIR for test isolation.
const originalConfigDir = process.env.OPENTABS_CONFIG_DIR;
process.env.OPENTABS_CONFIG_DIR = CONFIG_DIR;

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.OPENTABS_CONFIG_DIR;
  else process.env.OPENTABS_CONFIG_DIR = originalConfigDir;
  rmSync(TEST_BASE_DIR, { recursive: true, force: true });
});

const FILE_FIELD = { type: 'string', format: LOCAL_FILE_PATH_FORMAT };

describe('collectFilePaths', () => {
  const schema = {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      cover: FILE_FIELD,
      backup: { anyOf: [FILE_FIELD, { type: 'null' }] },
      attachments: {
        type: 'array',
        items: { type: 'object', properties: { path: FILE_FIELD, name: { type: 'string' } } },
      },
    },
  };

  test('finds file paths in top-level, nullable and array-nested fields, once each', () => {
    const args = {
      subject: '/not/a/file/field',
      cover: '/docs/cover.pdf',
      backup: '/docs/backup.zip',
      attachments: [{ path: '/docs/a.txt', name: '/also/not/a/file' }, { path: '/docs/cover.pdf' }],
    };
    expect(collectFilePaths(schema, args, LOCAL_FILE_PATH_FORMAT)).toEqual([
      '/docs/cover.pdf',
      '/docs/backup.zip',
      '/docs/a.txt',
    ]);
  });

  test('returns nothing when the call omits or nulls every file field', () => {
    expect(collectFilePaths(schema, { subject: 'hi', backup: null }, LOCAL_FILE_PATH_FORMAT)).toEqual([]);
  });

  test('returns nothing for a schema without file fields', () => {
    expect(
      collectFilePaths({ type: 'object', properties: { a: { type: 'string' } } }, { a: '/x' }, LOCAL_FILE_PATH_FORMAT),
    ).toEqual([]);
  });

  test('finds only the fields declared with the requested format', () => {
    const mixed = {
      type: 'object',
      properties: { source: FILE_FIELD, save_to: { type: 'string', format: SAVE_FILE_PATH_FORMAT } },
    };
    const args = { source: '/docs/in.pdf', save_to: '/tmp/out.xlsx' };
    expect(collectFilePaths(mixed, args, SAVE_FILE_PATH_FORMAT)).toEqual(['/tmp/out.xlsx']);
    expect(collectFilePaths(mixed, args, LOCAL_FILE_PATH_FORMAT)).toEqual(['/docs/in.pdf']);
  });
});

describe('resolveCallerPath', () => {
  test('maps a Git Bash drive path to its drive on Windows', () => {
    expect(resolveCallerPath('/c/Users/me/report.pdf', 'win32')).toBe(resolve('C:/Users/me/report.pdf'));
  });

  test('leaves the same path alone elsewhere', () => {
    expect(resolveCallerPath('/c/Users/me/report.pdf', 'linux')).toBe(resolve('/c/Users/me/report.pdf'));
  });
});

describe('contentTypeFor', () => {
  test('infers the MIME type from the extension, case-insensitively', () => {
    expect(contentTypeFor('Report.PDF')).toBe('application/pdf');
    expect(contentTypeFor('data.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  test('falls back to octet-stream for unknown extensions', () => {
    expect(contentTypeFor('archive.unknownext')).toBe('application/octet-stream');
    expect(contentTypeFor('README')).toBe('application/octet-stream');
  });
});

describe('readLocalFiles', () => {
  test('reads each file, keyed by the path the caller passed', async () => {
    const path = join(FILES_DIR, 'notes.txt');
    writeFileSync(path, 'hello');
    const result = await readLocalFiles([path]);
    expect(result).toEqual({
      ok: true,
      files: {
        [path]: { name: 'notes.txt', size: 5, contentType: 'text/plain', contentBase64: 'aGVsbG8=' },
      },
    });
  });

  test('refuses a relative path', async () => {
    expect(await readLocalFiles(['notes.txt'])).toEqual({
      ok: false,
      error: 'File path "notes.txt" must be absolute.',
    });
  });

  test('reports a missing file', async () => {
    const path = join(FILES_DIR, 'missing.txt');
    expect(await readLocalFiles([path])).toEqual({ ok: false, error: `File "${path}" was not found.` });
  });

  test('refuses a directory', async () => {
    expect(await readLocalFiles([FILES_DIR])).toEqual({ ok: false, error: `"${FILES_DIR}" is not a file.` });
  });

  test('refuses files in the OpenTabs config directory', async () => {
    const path = join(CONFIG_DIR, 'auth.json');
    writeFileSync(path, '{"secret":"x"}');
    expect(await readLocalFiles([path])).toEqual({
      ok: false,
      error: `File "${path}" is inside the OpenTabs config directory and cannot be read.`,
    });
  });

  test('refuses a call whose files exceed the size ceiling together', async () => {
    const half = Buffer.alloc(MAX_LOCAL_FILE_BYTES / 2 + 1);
    const first = join(FILES_DIR, 'first.bin');
    const second = join(FILES_DIR, 'second.bin');
    writeFileSync(first, half);
    writeFileSync(second, half);
    const result = await readLocalFiles([first, second]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`"${second}" brings the total to`);
  });
});

describe('writeSavedFiles', () => {
  const base64 = (text: string): string => Buffer.from(text).toString('base64');

  test('writes each saved file to the declared path', async () => {
    const path = join(FILES_DIR, 'saved.xlsx');
    expect(await writeSavedFiles([path], { [path]: base64('workbook bytes') })).toEqual({ ok: true });
    expect(readFileSync(path, 'utf-8')).toBe('workbook bytes');
  });

  test('overwrites an existing regular file', async () => {
    const path = join(FILES_DIR, 'overwrite.txt');
    writeFileSync(path, 'old');
    expect(await writeSavedFiles([path], { [path]: base64('new') })).toEqual({ ok: true });
    expect(readFileSync(path, 'utf-8')).toBe('new');
  });

  test('refuses a path the call did not declare, writing nothing', async () => {
    const declared = join(FILES_DIR, 'declared.txt');
    const undeclared = join(FILES_DIR, 'undeclared.txt');
    const result = await writeSavedFiles([declared], { [declared]: base64('a'), [undeclared]: base64('b') });
    expect(result).toEqual({
      ok: false,
      error: `The tool tried to save a file to "${undeclared}", which this call did not name as a save path.`,
    });
    expect(existsSync(declared)).toBe(false);
    expect(existsSync(undeclared)).toBe(false);
  });

  test('refuses a relative path', async () => {
    expect(await writeSavedFiles(['out.txt'], { 'out.txt': base64('a') })).toEqual({
      ok: false,
      error: 'Save path "out.txt" must be absolute.',
    });
  });

  test('refuses a folder that does not exist', async () => {
    const path = join(FILES_DIR, 'no-such-folder', 'out.txt');
    expect(await writeSavedFiles([path], { [path]: base64('a') })).toEqual({
      ok: false,
      error: `The folder for "${path}" does not exist.`,
    });
  });

  test('refuses the OpenTabs config directory', async () => {
    const path = join(CONFIG_DIR, 'auth.json');
    expect(await writeSavedFiles([path], { [path]: base64('{}') })).toEqual({
      ok: false,
      error: `"${path}" is inside the OpenTabs config directory and cannot be written.`,
    });
  });

  test('refuses to replace a directory', async () => {
    const path = join(FILES_DIR, 'a-directory');
    mkdirSync(path, { recursive: true });
    expect(await writeSavedFiles([path], { [path]: base64('a') })).toEqual({
      ok: false,
      error: `"${path}" already exists and is not a regular file.`,
    });
  });

  test('refuses content that is not base64', async () => {
    const path = join(FILES_DIR, 'bad.txt');
    expect(await writeSavedFiles([path], { [path]: 'not base64!' })).toEqual({
      ok: false,
      error: `The tool returned malformed content for "${path}".`,
    });
  });

  test('refuses a malformed saved-files payload', async () => {
    expect(await writeSavedFiles([], 'nope')).toEqual({ ok: false, error: 'The tool returned malformed saved files.' });
  });

  test('refuses files that exceed the size ceiling together, writing nothing', async () => {
    const half = Buffer.alloc(MAX_LOCAL_FILE_BYTES / 2 + 1).toString('base64');
    const first = join(FILES_DIR, 'big-first.bin');
    const second = join(FILES_DIR, 'big-second.bin');
    const result = await writeSavedFiles([first, second], { [first]: half, [second]: half });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`"${second}" brings the total to`);
    expect(existsSync(first)).toBe(false);
  });
});
