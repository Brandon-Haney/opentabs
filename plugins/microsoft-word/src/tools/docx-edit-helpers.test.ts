import { ToolError } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ZipEntry } from '../docx-utils.js';
import { graphFetch } from '../microsoft-word-api.js';
import { uploadModifiedDocx } from './docx-edit-helpers.js';

vi.mock('../microsoft-word-api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../microsoft-word-api.js')>()),
  graphFetch: vi.fn(),
}));

const mockGraphFetch = vi.mocked(graphFetch);

const entries = (): ZipEntry[] => [
  { name: 'word/document.xml', data: new TextEncoder().encode('<w:document>old</w:document>') },
];

/** The options `uploadModifiedDocx` passed to graphFetch on its single call. */
const sentOptions = (): Record<string, unknown> => (mockGraphFetch.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;

beforeEach(() => {
  mockGraphFetch.mockReset();
  mockGraphFetch.mockResolvedValue(new Response(null, { status: 200 }));
});

describe('uploadModifiedDocx', () => {
  test('pins the write to the version the document was read at', async () => {
    await uploadModifiedDocx('item-1', entries(), 0, '<w:document>new</w:document>', '"abc,1"');

    expect(mockGraphFetch).toHaveBeenCalledWith('/me/drive/items/item-1/content', expect.anything());
    expect(sentOptions().ifMatch).toBe('"abc,1"');
    expect(sentOptions().method).toBe('PUT');
  });

  test('sends no If-Match when Graph reported no version', async () => {
    // Better to write than to refuse every write on an item whose metadata
    // carried no eTag; the guard is an improvement, not a precondition.
    await uploadModifiedDocx('item-1', entries(), 0, '<w:document>new</w:document>', undefined);

    expect('ifMatch' in sentOptions()).toBe(false);
  });

  test('replays only because the version is pinned', async () => {
    // The bytes are fixed inside the call, so a replay re-sends identical
    // content; If-Match is what stops a replay landing after someone else's
    // edit and overwriting it.
    await uploadModifiedDocx('item-1', entries(), 0, '<w:document>new</w:document>', '"abc,1"');

    expect(sentOptions().retryNonIdempotent).toBe(true);
  });

  test('refuses rather than discarding an edit made since the read', async () => {
    mockGraphFetch.mockResolvedValue(new Response(null, { status: 412 }));

    await expect(uploadModifiedDocx('item-1', entries(), 0, '<w:document>new</w:document>', '"stale"')).rejects.toThrow(
      ToolError,
    );
    await expect(uploadModifiedDocx('item-1', entries(), 0, '<w:document>new</w:document>', '"stale"')).rejects.toThrow(
      /changed while this edit was being prepared/,
    );
  });

  test('substitutes the new document.xml at the index it was told', async () => {
    const zipEntries = entries();
    await uploadModifiedDocx('item-1', zipEntries, 0, '<w:document>new</w:document>', '"abc,1"');

    expect(zipEntries[0]?.name).toBe('word/document.xml');
    expect(new TextDecoder().decode(zipEntries[0]?.data)).toBe('<w:document>new</w:document>');
  });
});
