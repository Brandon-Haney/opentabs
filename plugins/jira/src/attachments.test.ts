import type { LocalFile, ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getMediaIds, mediaSingleNode, readCommentImages, uploadAttachments } from './attachments.js';
import * as jiraApi from './jira-api.js';

vi.mock('./jira-api.js', () => ({ api: vi.fn() }));

const api = vi.mocked(jiraApi.api);

const file = (name: string, contentType = 'image/png'): LocalFile => ({
  name,
  size: 3,
  contentType,
  contentBase64: 'AAAA',
});

const contextWith = (files: Record<string, LocalFile>): ToolHandlerContext => ({
  reportProgress: vi.fn(),
  localFile: path => {
    const delivered = files[path];
    if (!delivered) throw new Error(`no file for ${path}`);
    return delivered;
  },
});

const credentials = (files: [number, string][]) => ({
  tokensWithFiles: [
    { files: files.map(([attachmentId, attachmentMediaApiId]) => ({ attachmentId, attachmentMediaApiId })) },
  ],
});

beforeEach(() => {
  api.mockReset();
});

describe('uploadAttachments', () => {
  test('uploads each file in its own multipart request, in order, reporting progress before each', async () => {
    api.mockResolvedValueOnce([{ id: '11', filename: 'a.png', size: 3, mimeType: 'image/png' }]);
    api.mockResolvedValueOnce([{ id: '12', filename: 'b.pdf', size: 3, mimeType: 'application/pdf' }]);
    const context = contextWith({});

    const attachments = await uploadAttachments('KAN-1', [file('a.png'), file('b.pdf', 'application/pdf')], context);

    expect(attachments.map(a => a.id)).toEqual(['11', '12']);
    expect(api).toHaveBeenCalledTimes(2);
    const [endpoint, options] = api.mock.calls[0] ?? [];
    expect(endpoint).toBe('/issue/KAN-1/attachments');
    expect(options?.method).toBe('POST');
    const uploaded = options?.form?.get('file');
    expect(uploaded).toBeInstanceOf(Blob);
    expect((uploaded as File).name).toBe('a.png');
    expect(context.reportProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({ progress: 0, total: 2 }));
    expect(context.reportProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({ progress: 1, total: 2 }));
  });
});

describe('getMediaIds', () => {
  test('maps attachment ids to media ids from the read credentials, in the order asked', async () => {
    api.mockResolvedValueOnce(
      credentials([
        [11, 'media-a'],
        [12, 'media-b'],
        [9, 'media-old'],
      ]),
    );

    await expect(getMediaIds('KAN-1', ['12', '11'])).resolves.toEqual(['media-b', 'media-a']);
    expect(api).toHaveBeenCalledWith('/attachment/read/issue/KAN-1/credentials', {
      basePath: '/rest/api/2',
      query: { maxTokenLength: 65536 },
    });
  });

  test('retries until a just-uploaded attachment is listed', async () => {
    vi.useFakeTimers();
    try {
      api.mockResolvedValueOnce(credentials([])).mockResolvedValueOnce(credentials([[11, 'media-a']]));
      const result = getMediaIds('KAN-1', ['11']);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual(['media-a']);
      expect(api).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('gives up naming the attachments Jira never listed', async () => {
    vi.useFakeTimers();
    try {
      api.mockResolvedValue(credentials([]));
      const result = getMediaIds('KAN-1', ['11']);
      const assertion = expect(result).rejects.toThrow('Attachments 11 were uploaded to KAN-1');
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mediaSingleNode', () => {
  test('points at the media id in the stored-attachment form, capping the shown width', () => {
    expect(mediaSingleNode('media-a', 'wide.png', { width: 1200, height: 600 })).toEqual({
      type: 'mediaSingle',
      attrs: { layout: 'align-start', width: 686, widthType: 'pixel' },
      content: [
        {
          type: 'media',
          attrs: { type: 'file', id: 'media-a', collection: '', alt: 'wide.png', width: 1200, height: 600 },
        },
      ],
    });
  });

  test('leaves sizing to Jira when the image size is unknown', () => {
    expect(mediaSingleNode('media-a', 'x.png', undefined)).toEqual({
      type: 'mediaSingle',
      attrs: { layout: 'align-start' },
      content: [{ type: 'media', attrs: { type: 'file', id: 'media-a', collection: '', alt: 'x.png' } }],
    });
  });
});

describe('readCommentImages', () => {
  test('rejects a file that is not an image', () => {
    const context = contextWith({ '/tmp/a.png': file('a.png'), '/tmp/notes.txt': file('notes.txt', 'text/plain') });
    expect(() => readCommentImages(context, [{ path: '/tmp/a.png' }, { path: '/tmp/notes.txt' }])).toThrow(
      'Image 2 (notes.txt) is not an image file.',
    );
  });
});
