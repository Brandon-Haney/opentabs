import type { LocalFile, ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { attachToDraft, referencedContentIds, validateInlineImages } from './attachments.js';
import type { UploadProgressReporter } from './outlook-api.js';
import * as outlookApi from './outlook-api.js';

vi.mock('./outlook-api.js', () => ({
  attachFileToMessage: vi.fn(async () => undefined),
  attachLargeFileToMessage: vi.fn(async () => undefined),
  attachReferenceToMessage: vi.fn(async () => undefined),
  uploadAttachmentToOneDrive: vi.fn(async () => 'https://contoso-my.sharepoint.com/:b:/g/personal/x'),
}));

const { attachFileToMessage, attachLargeFileToMessage, attachReferenceToMessage, uploadAttachmentToOneDrive } =
  vi.mocked(outlookApi);

/**
 * Base64 of `length` zero bytes — sized by the decoded byte count, which drives the
 * inline-vs-chunked split. Three zero bytes encode as "AAAA"; a partial final group pads.
 */
const base64OfLength = (length: number): string => {
  const whole = 'A'.repeat(Math.floor(length / 3) * 4);
  const remainder = length % 3;
  if (remainder === 0) return whole;
  return remainder === 1 ? `${whole}AA==` : `${whole}AAA=`;
};

const LARGE_BYTES = 3_000_001;

/** The files the server delivered for this call, keyed by the path the caller passed. */
const LOCAL_FILES: Record<string, LocalFile> = {
  '/home/me/docs/note.txt': { name: 'note.txt', size: 3, contentType: 'text/plain', contentBase64: base64OfLength(3) },
  '/home/me/docs/big.pdf': {
    name: 'big.pdf',
    size: LARGE_BYTES,
    contentType: 'application/pdf',
    contentBase64: base64OfLength(LARGE_BYTES),
  },
  '/home/me/docs/chart.png': { name: 'chart.png', size: 3, contentType: 'image/png', contentBase64: 'AAAA' },
};

const SMALL = { path: '/home/me/docs/note.txt' };
const CHART = { path: '/home/me/docs/chart.png', content_id: 'chart1' };
const LARGE = { path: '/home/me/docs/big.pdf' };

let context: ToolHandlerContext;

beforeEach(() => {
  vi.clearAllMocks();
  context = {
    reportProgress: vi.fn(),
    localFile: path => {
      const file = LOCAL_FILES[path];
      if (!file) throw new Error(`No local file was read for "${path}"`);
      return file;
    },
  };
});

describe('attachToDraft', () => {
  test('does nothing, and reports nothing, without attachments', async () => {
    await attachToDraft('draft-1', {}, context);
    await attachToDraft('draft-1', { attachments: [], inline_images: [] }, context);
    expect(attachFileToMessage).not.toHaveBeenCalled();
    expect(context.reportProgress).not.toHaveBeenCalled();
  });

  test('reports one step per attached file on the attachments-completed scale', async () => {
    await attachToDraft('draft-1', { attachments: [SMALL, { ...SMALL, name: 'other.txt' }] }, context);
    expect(attachFileToMessage).toHaveBeenCalledTimes(2);
    expect(attachFileToMessage).toHaveBeenNthCalledWith(1, 'draft-1', {
      name: 'note.txt',
      contentType: 'text/plain',
      contentBase64: 'AAAA',
    });
    expect(attachFileToMessage).toHaveBeenNthCalledWith(2, 'draft-1', expect.objectContaining({ name: 'other.txt' }));
    expect(vi.mocked(context.reportProgress).mock.calls).toEqual([
      [{ progress: 1, total: 2, message: 'Attachment 1 of 2 attached' }],
      [{ progress: 2, total: 2, message: 'Attachment 2 of 2 attached' }],
    ]);
  });

  test('relays chunk progress of a large embed as a fraction of the current attachment', async () => {
    attachLargeFileToMessage.mockImplementationOnce(async (_messageId, file, onProgress?: UploadProgressReporter) => {
      const total = file.bytes.byteLength;
      onProgress?.(total / 4, total);
      onProgress?.(total, total);
    });

    await attachToDraft('draft-1', { attachments: [SMALL, LARGE] }, context);

    expect(attachLargeFileToMessage).toHaveBeenCalledWith(
      'draft-1',
      expect.objectContaining({ name: 'big.pdf', contentType: 'application/pdf' }),
      expect.any(Function),
    );
    expect(vi.mocked(context.reportProgress).mock.calls).toEqual([
      [{ progress: 1, total: 2, message: 'Attachment 1 of 2 attached' }],
      [{ progress: 1.25, total: 2, message: 'Attachment 2 of 2: 0.8 MB of 3.0 MB uploaded' }],
      [{ progress: 2, total: 2, message: 'Attachment 2 of 2: 3.0 MB of 3.0 MB uploaded' }],
      [{ progress: 2, total: 2, message: 'Attachment 2 of 2 attached' }],
    ]);
  });

  test('never includes the attachment name in a progress message', async () => {
    await attachToDraft('draft-1', { attachments: [{ ...SMALL, as_cloud_link: true }] }, context);
    expect(uploadAttachmentToOneDrive).toHaveBeenCalledTimes(1);
    expect(attachReferenceToMessage).toHaveBeenCalledTimes(1);
    for (const [options] of vi.mocked(context.reportProgress).mock.calls) {
      expect(options.message).not.toContain('note.txt');
    }
  });

  test('attaches nothing when any file was not delivered', async () => {
    await expect(
      attachToDraft('draft-1', { attachments: [SMALL, { path: '/home/me/docs/missing.txt' }] }, context),
    ).rejects.toThrow('No local file was read for "/home/me/docs/missing.txt"');
    expect(attachFileToMessage).not.toHaveBeenCalled();
  });

  test('fails without a context that can deliver local files', async () => {
    await expect(attachToDraft('draft-1', { attachments: [SMALL] })).rejects.toThrow('cannot read local files');
    expect(attachFileToMessage).not.toHaveBeenCalled();
  });

  test('attaches inline images first, marked with their content id', async () => {
    await attachToDraft('draft-1', { attachments: [SMALL], inline_images: [CHART] }, context);
    expect(attachFileToMessage).toHaveBeenNthCalledWith(1, 'draft-1', {
      name: 'chart.png',
      contentType: 'image/png',
      contentId: 'chart1',
      contentBase64: 'AAAA',
    });
    expect(attachFileToMessage).toHaveBeenNthCalledWith(2, 'draft-1', expect.objectContaining({ name: 'note.txt' }));
  });

  test('rejects an inline image that is not an image file, before attaching anything', async () => {
    await expect(
      attachToDraft('draft-1', { attachments: [SMALL], inline_images: [{ ...SMALL, content_id: 'x' }] }, context),
    ).rejects.toThrow('Inline image "x" (note.txt) is not an image file.');
    expect(attachFileToMessage).not.toHaveBeenCalled();
  });
});

describe('referencedContentIds', () => {
  test('collects every cid: reference in an HTML body', () => {
    const html = `<img src="cid:chart1"><img src='cid:image001.png@01DA0000'><img src="https://x/y.png">`;
    expect(referencedContentIds(html)).toEqual(new Set(['chart1', 'image001.png@01DA0000']));
  });
});

describe('validateInlineImages', () => {
  const placed = '<p>See <img src="cid:chart1"></p>';

  test('accepts images that the HTML body places', () => {
    expect(() => validateInlineImages(placed, 'html', [CHART])).not.toThrow();
  });

  test('requires an HTML body for inline images', () => {
    expect(() => validateInlineImages(placed, 'text', [CHART])).toThrow('set body_type to "html"');
    expect(() => validateInlineImages(placed, undefined, [CHART])).toThrow('set body_type to "html"');
  });

  test('rejects an image the body never places', () => {
    expect(() => validateInlineImages('<p>none</p>', 'html', [CHART])).toThrow(
      'Inline image "chart1" is never placed in the body',
    );
  });

  test('rejects a cid the body shows without an image', () => {
    expect(() => validateInlineImages(placed, 'html', [])).toThrow('no inline image has content_id "chart1"');
  });

  test('accepts a cid that names an image already on the draft', () => {
    expect(() => validateInlineImages(placed, 'html', [], new Set(['chart1']))).not.toThrow();
  });

  test('rejects a repeated content id', () => {
    expect(() => validateInlineImages(placed, 'html', [CHART, CHART])).toThrow('is repeated');
  });

  test('ignores cid-like text in a plain-text body without images', () => {
    expect(() => validateInlineImages('cid:chart1', 'text', [])).not.toThrow();
  });
});
