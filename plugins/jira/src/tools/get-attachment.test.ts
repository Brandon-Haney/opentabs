import { MAX_LOCAL_FILE_BYTES, type ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as jiraApi from '../jira-api.js';
import { getAttachment } from './get-attachment.js';

vi.mock('../jira-api.js', () => ({ api: vi.fn(), apiBytes: vi.fn() }));

const api = vi.mocked(jiraApi.api);
const apiBytes = vi.mocked(jiraApi.apiBytes);

const saveFile = vi.fn();
const context: ToolHandlerContext = { reportProgress: vi.fn(), saveFile };

const INFO = { id: '9', filename: 'a.png', size: 3, mimeType: 'image/png' };
const PARAMS = { attachment_id: '9', save_to: '/tmp/a.png' };

beforeEach(() => {
  api.mockReset();
  apiBytes.mockReset();
  saveFile.mockReset();
});

describe('get_attachment', () => {
  test('downloads through the non-redirecting endpoint and saves the file', async () => {
    api.mockResolvedValue(INFO);
    apiBytes.mockResolvedValue(new Uint8Array([104, 105, 33]));

    const result = await getAttachment.handle(PARAMS, context);

    expect(apiBytes).toHaveBeenCalledWith(
      '/attachment/content/9',
      expect.objectContaining({ query: { redirect: false } }),
    );
    expect(saveFile).toHaveBeenCalledWith('/tmp/a.png', 'aGkh');
    expect(result).toEqual({
      attachment: { id: '9', filename: 'a.png', size: 3, mime_type: 'image/png' },
      saved_to: '/tmp/a.png',
    });
  });

  test('encodes a file larger than one encoding chunk as one base64 string', async () => {
    const size = 3 * 8192 + 1;
    api.mockResolvedValue({ ...INFO, size });
    apiBytes.mockResolvedValue(new Uint8Array(size).fill(65));

    await getAttachment.handle(PARAMS, context);

    expect(saveFile.mock.calls[0]?.[1]).toBe(Buffer.alloc(size, 65).toString('base64'));
  });

  test('refuses a file over the limit before downloading it', async () => {
    api.mockResolvedValue({ ...INFO, size: MAX_LOCAL_FILE_BYTES + 1 });

    await expect(getAttachment.handle(PARAMS, context)).rejects.toThrow('files saved in one call may be at most');
    expect(apiBytes).not.toHaveBeenCalled();
  });

  test('saves nothing when the download is not the size Jira reported', async () => {
    api.mockResolvedValue(INFO);
    apiBytes.mockResolvedValue(new Uint8Array(2));

    await expect(getAttachment.handle(PARAMS, context)).rejects.toThrow('Nothing was saved');
    expect(saveFile).not.toHaveBeenCalled();
  });
});
