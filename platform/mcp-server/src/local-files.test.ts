import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCAL_FILE_PATH_FORMAT, MAX_LOCAL_FILE_BYTES } from '@opentabs-dev/shared';
import { afterAll, describe, expect, test } from 'vitest';
import { collectLocalFilePaths, contentTypeFor, readLocalFiles, resolveCallerPath } from './local-files.js';

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

describe('collectLocalFilePaths', () => {
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
    expect(collectLocalFilePaths(schema, args)).toEqual(['/docs/cover.pdf', '/docs/backup.zip', '/docs/a.txt']);
  });

  test('returns nothing when the call omits or nulls every file field', () => {
    expect(collectLocalFilePaths(schema, { subject: 'hi', backup: null })).toEqual([]);
  });

  test('returns nothing for a schema without file fields', () => {
    expect(collectLocalFilePaths({ type: 'object', properties: { a: { type: 'string' } } }, { a: '/x' })).toEqual([]);
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
