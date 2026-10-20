import { describe, expect, test, vi } from 'vitest';
import type { LocalFile, ToolHandlerContext } from './index.js';
import { readLocalFile, saveLocalFile } from './local-files.js';

const FILE: LocalFile = { name: 'a.txt', size: 1, contentType: 'text/plain', contentBase64: 'YQ==' };

describe('readLocalFile', () => {
  test('returns the file the platform delivered for the path', () => {
    const context: ToolHandlerContext = { reportProgress: vi.fn(), localFile: () => FILE };
    expect(readLocalFile(context, '/docs/a.txt')).toBe(FILE);
  });

  test('reports a path with no delivered file as a validation error', () => {
    const context: ToolHandlerContext = {
      reportProgress: vi.fn(),
      localFile: () => {
        throw new Error('missing');
      },
    };
    expect(() => readLocalFile(context, '/docs/b.txt')).toThrow(
      expect.objectContaining({ category: 'validation', message: 'No local file was read for "/docs/b.txt".' }),
    );
  });

  test('reports a platform without local-file delivery as a validation error', () => {
    expect(() => readLocalFile({ reportProgress: vi.fn() }, '/docs/a.txt')).toThrow(
      expect.objectContaining({ category: 'validation', message: expect.stringContaining('cannot read local files') }),
    );
    expect(() => readLocalFile(undefined, '/docs/a.txt')).toThrow(expect.objectContaining({ category: 'validation' }));
  });
});

describe('saveLocalFile', () => {
  test('hands the bytes to the platform for the path', () => {
    const saveFile = vi.fn();
    saveLocalFile({ reportProgress: vi.fn(), saveFile }, '/tmp/a.xlsx', 'YQ==');
    expect(saveFile).toHaveBeenCalledWith('/tmp/a.xlsx', 'YQ==');
  });

  test('reports a platform without file saving as a validation error', () => {
    expect(() => saveLocalFile({ reportProgress: vi.fn() }, '/tmp/a.xlsx', 'YQ==')).toThrow(
      expect.objectContaining({ category: 'validation', message: expect.stringContaining('cannot save files') }),
    );
    expect(() => saveLocalFile(undefined, '/tmp/a.xlsx', 'YQ==')).toThrow(
      expect.objectContaining({ category: 'validation' }),
    );
  });
});
