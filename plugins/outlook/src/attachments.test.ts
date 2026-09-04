import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { attachToDraft } from './attachments.js';
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
const SMALL = { name: 'note.txt', content_base64: base64OfLength(3) };
const LARGE = { name: 'big.bin', content_base64: base64OfLength(LARGE_BYTES), content_type: 'application/pdf' };

let context: ToolHandlerContext;

beforeEach(() => {
  vi.clearAllMocks();
  context = { reportProgress: vi.fn() };
});

describe('attachToDraft', () => {
  test('does nothing, and reports nothing, without attachments', async () => {
    await attachToDraft('draft-1', undefined, context);
    await attachToDraft('draft-1', [], context);
    expect(attachFileToMessage).not.toHaveBeenCalled();
    expect(context.reportProgress).not.toHaveBeenCalled();
  });

  test('reports one step per attached file on the attachments-completed scale', async () => {
    await attachToDraft('draft-1', [SMALL, { ...SMALL, name: 'other.txt' }], context);
    expect(attachFileToMessage).toHaveBeenCalledTimes(2);
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

    await attachToDraft('draft-1', [SMALL, LARGE], context);

    expect(attachLargeFileToMessage).toHaveBeenCalledWith(
      'draft-1',
      expect.objectContaining({ name: 'big.bin', contentType: 'application/pdf' }),
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
    await attachToDraft('draft-1', [{ ...SMALL, as_cloud_link: true }], context);
    expect(uploadAttachmentToOneDrive).toHaveBeenCalledTimes(1);
    expect(attachReferenceToMessage).toHaveBeenCalledTimes(1);
    for (const [options] of vi.mocked(context.reportProgress).mock.calls) {
      expect(options.message).not.toContain('note.txt');
    }
  });

  test('works without a context, as when a handler receives none', async () => {
    await expect(attachToDraft('draft-1', [SMALL])).resolves.toBeUndefined();
    expect(attachFileToMessage).toHaveBeenCalledTimes(1);
  });
});
