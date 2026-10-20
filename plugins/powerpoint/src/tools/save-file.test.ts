import { MAX_LOCAL_FILE_BYTES, type ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { api, encodeBase64, fetchDownloadUrl, graphFetch, requireDriveId } from '../powerpoint-api.js';
import { convertedFileName, saveFile } from './save-file.js';

vi.mock('../powerpoint-api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../powerpoint-api.js')>()),
  api: vi.fn(),
  fetchDownloadUrl: vi.fn(),
  graphFetch: vi.fn(),
  requireDriveId: vi.fn(),
}));

const apiMock = vi.mocked(api);
const fetchDownloadUrlMock = vi.mocked(fetchDownloadUrl);
const graphFetchMock = vi.mocked(graphFetch);
const DOWNLOAD_URL = 'https://contoso-my.sharepoint.com/download.aspx?tempauth=secret';
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const handlerContext = () => {
  const saveFileMock = vi.fn<(path: string, contentBase64: string) => void>();
  const context: ToolHandlerContext = { reportProgress: () => undefined, saveFile: saveFileMock };
  return { context, saveFileMock };
};

beforeEach(() => {
  apiMock.mockReset();
  fetchDownloadUrlMock.mockReset();
  graphFetchMock.mockReset();
  vi.mocked(requireDriveId).mockResolvedValue('drive-1');
});

describe('encodeBase64', () => {
  test('round-trips an array larger than one encoding slice', () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 256);
    expect(Uint8Array.from(atob(encodeBase64(bytes)), c => c.charCodeAt(0))).toEqual(bytes);
  });
});

describe('convertedFileName', () => {
  test('swaps the extension for the format', () => {
    expect(convertedFileName('Q3 Review.pptx', 'pdf')).toBe('Q3 Review.pdf');
  });

  test('appends the extension to a name without one', () => {
    expect(convertedFileName('notes', 'png')).toBe('notes.png');
  });
});

describe('save_file', () => {
  test('writes the original file from its pre-authenticated download URL', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    apiMock.mockResolvedValue({
      name: 'deck.pptx',
      size: bytes.length,
      file: { mimeType: PPTX_TYPE },
      '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
    });
    fetchDownloadUrlMock.mockResolvedValue(new Response(bytes));
    const { context, saveFileMock } = handlerContext();

    const result = await saveFile.handle({ item_id: 'item-1', save_to: '/tmp/deck.pptx' }, context);

    expect(apiMock).toHaveBeenCalledWith('/drives/drive-1/items/item-1');
    expect(fetchDownloadUrlMock).toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything());
    expect(graphFetchMock).not.toHaveBeenCalled();
    expect(saveFileMock).toHaveBeenCalledWith('/tmp/deck.pptx', btoa(String.fromCharCode(...bytes)));
    expect(result).toEqual({ saved_to: '/tmp/deck.pptx', name: 'deck.pptx', size: 6, content_type: PPTX_TYPE });
  });

  test('fetches a conversion through the authenticated content endpoint', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    apiMock.mockResolvedValue({ name: 'deck.pptx', size: 100, '@microsoft.graph.downloadUrl': DOWNLOAD_URL });
    graphFetchMock.mockResolvedValue(new Response(bytes));
    const { context, saveFileMock } = handlerContext();

    const result = await saveFile.handle({ item_id: 'item-1', save_to: '/tmp/deck.pdf', format: 'pdf' }, context);

    expect(graphFetchMock).toHaveBeenCalledWith(
      '/drives/drive-1/items/item-1/content',
      expect.objectContaining({ query: { format: 'pdf' } }),
    );
    expect(fetchDownloadUrlMock).not.toHaveBeenCalled();
    expect(saveFileMock).toHaveBeenCalledWith('/tmp/deck.pdf', btoa(String.fromCharCode(...bytes)));
    expect(result).toEqual({ saved_to: '/tmp/deck.pdf', name: 'deck.pdf', size: 4, content_type: 'application/pdf' });
  });

  test('refuses a file over the save limit before downloading it', async () => {
    apiMock.mockResolvedValue({
      name: 'huge.pptx',
      size: MAX_LOCAL_FILE_BYTES + 1,
      '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
    });
    const { context, saveFileMock } = handlerContext();

    await expect(saveFile.handle({ item_id: 'item-1', save_to: '/tmp/huge.pptx' }, context)).rejects.toThrow(
      'at most 25 MB',
    );
    expect(fetchDownloadUrlMock).not.toHaveBeenCalled();
    expect(saveFileMock).not.toHaveBeenCalled();
  });

  test('refuses a folder', async () => {
    apiMock.mockResolvedValue({ name: 'Decks', folder: { childCount: 2 } });
    const { context } = handlerContext();

    await expect(saveFile.handle({ item_id: 'item-1', save_to: '/tmp/x' }, context)).rejects.toThrow('is a folder');
  });
});
