import { MAX_LOCAL_FILE_BYTES, type ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { api, fetchDownloadUrl } from '../microsoft-word-api.js';
import { getFileContent } from './get-file-content.js';

vi.mock('../microsoft-word-api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../microsoft-word-api.js')>()),
  api: vi.fn(),
  fetchDownloadUrl: vi.fn(),
}));

const apiMock = vi.mocked(api);
const fetchDownloadUrlMock = vi.mocked(fetchDownloadUrl);
const DOWNLOAD_URL = 'https://contoso-my.sharepoint.com/download.aspx?tempauth=secret';

const handlerContext = () => {
  const saveFile = vi.fn<(path: string, contentBase64: string) => void>();
  const context: ToolHandlerContext = { reportProgress: () => undefined, saveFile };
  return { context, saveFile };
};

beforeEach(() => {
  apiMock.mockReset();
  fetchDownloadUrlMock.mockReset();
});

describe('get_file_content', () => {
  test('returns the text of a file when save_to is absent', async () => {
    apiMock.mockResolvedValue({ name: 'notes.md', size: 5, '@microsoft.graph.downloadUrl': DOWNLOAD_URL });
    fetchDownloadUrlMock.mockResolvedValue(new Response('hello'));
    const { context, saveFile } = handlerContext();

    const result = await getFileContent.handle({ item_id: 'item-1' }, context);

    expect(result).toEqual({ content: 'hello', size: 5 });
    expect(saveFile).not.toHaveBeenCalled();
  });

  test('reads a .csv inline even though OneDrive reports it as a spreadsheet type', async () => {
    apiMock.mockResolvedValue({
      name: 'report.csv',
      file: { mimeType: 'application/vnd.ms-excel' },
      '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
    });
    fetchDownloadUrlMock.mockResolvedValue(new Response('a,b'));

    const result = await getFileContent.handle({ item_id: 'item-1' }, handlerContext().context);

    expect(result).toEqual({ content: 'a,b', size: 3 });
  });

  test('refuses to read a binary file inline, pointing at save_to', async () => {
    apiMock.mockResolvedValue({
      name: 'plan.docx',
      file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
    });

    await expect(getFileContent.handle({ item_id: 'item-1' }, handlerContext().context)).rejects.toThrow(
      /"plan\.docx" .* is not a text file\. Pass save_to/,
    );
    expect(fetchDownloadUrlMock).not.toHaveBeenCalled();
  });

  test('writes the raw bytes to save_to and reports the file, not its content', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    apiMock.mockResolvedValue({
      name: 'report.pdf',
      size: bytes.length,
      file: { mimeType: 'application/pdf' },
      '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
    });
    fetchDownloadUrlMock.mockResolvedValue(new Response(bytes));
    const { context, saveFile } = handlerContext();

    const result = await getFileContent.handle({ item_id: 'item-1', save_to: '/tmp/report.pdf' }, context);

    expect(saveFile).toHaveBeenCalledWith('/tmp/report.pdf', btoa(String.fromCharCode(...bytes)));
    expect(result).toEqual({
      saved_to: '/tmp/report.pdf',
      size: bytes.length,
      name: 'report.pdf',
      content_type: 'application/pdf',
    });
  });

  test('refuses a file over the save limit before downloading it', async () => {
    apiMock.mockResolvedValue({
      name: 'huge.zip',
      size: MAX_LOCAL_FILE_BYTES + 1,
      '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
    });
    const { context, saveFile } = handlerContext();

    await expect(getFileContent.handle({ item_id: 'item-1', save_to: '/tmp/huge.zip' }, context)).rejects.toThrow(
      'at most 25 MB',
    );
    expect(fetchDownloadUrlMock).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  test('refuses a folder', async () => {
    apiMock.mockResolvedValue({ name: 'Documents', folder: { childCount: 3 } });
    const { context } = handlerContext();

    await expect(getFileContent.handle({ item_id: 'item-1', save_to: '/tmp/x' }, context)).rejects.toThrow(
      'is a folder',
    );
  });
});
