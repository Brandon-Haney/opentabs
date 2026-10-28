import type { LocalFile, ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as attachments from '../attachments.js';
import * as jiraApi from '../jira-api.js';
import type { AdfDoc, AdfNode } from './adf.js';
import { addComment } from './add-comment.js';

vi.mock('../jira-api.js', () => ({ api: vi.fn() }));
vi.mock('../attachments.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../attachments.js')>()),
  attachCommentImages: vi.fn(),
}));

const api = vi.mocked(jiraApi.api);
const attachCommentImages = vi.mocked(attachments.attachCommentImages);

const png = (name: string): LocalFile => ({ name, size: 3, contentType: 'image/png', contentBase64: 'AAAA' });

const context: ToolHandlerContext = {
  reportProgress: vi.fn(),
  localFile: path => png(path.split('/').pop() ?? path),
};

const imageBlock = (n: number): AdfNode => ({ type: 'mediaSingle', attrs: { n } });

/** The ADF body the tool posted. */
const postedBody = (): AdfDoc => {
  const call = api.mock.calls.find(([, options]) => options?.method === 'POST');
  return (call?.[1]?.body as { body: AdfDoc }).body;
};

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ id: '100', body: { type: 'doc', version: 1, content: [] } });
  attachCommentImages.mockReset();
  attachCommentImages.mockImplementation(async (_key, images) => images.map((_, i) => imageBlock(i + 1)));
});

describe('add_comment images', () => {
  test('places referenced images where the body names them and appends the rest', async () => {
    await addComment.handle(
      {
        issue_key: 'KAN-1',
        body: 'Intro\n\n![second](image:2)\n\nOutro',
        images: [{ path: '/tmp/one.png' }, { path: '/tmp/two.png' }],
      },
      context,
    );

    expect(attachCommentImages).toHaveBeenCalledWith(
      'KAN-1',
      [{ path: '/tmp/one.png' }, { path: '/tmp/two.png' }],
      [png('one.png'), png('two.png')],
      context,
    );
    expect(postedBody().content.map(n => (n.type === 'mediaSingle' ? `image ${n.attrs?.n}` : n.type))).toEqual([
      'paragraph',
      'image 2',
      'paragraph',
      'image 1',
    ]);
  });

  test('posts images alone when there is no body', async () => {
    await addComment.handle({ issue_key: 'KAN-1', images: [{ path: '/tmp/one.png' }] }, context);
    expect(postedBody().content).toEqual([imageBlock(1)]);
  });

  test('rejects a reference to an image that was not passed, before uploading anything', async () => {
    await expect(
      addComment.handle({ issue_key: 'KAN-1', body: '![x](image:3)', images: [{ path: '/tmp/one.png' }] }, context),
    ).rejects.toThrow('The body places ![…](image:3), but 1 image(s) were passed in `images`.');
    expect(attachCommentImages).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  test('appends images after a raw ADF body', async () => {
    const body_adf = { type: 'doc', version: 1, content: [{ type: 'paragraph' }] };
    await addComment.handle({ issue_key: 'KAN-1', body_adf, images: [{ path: '/tmp/one.png' }] }, context);
    expect(postedBody().content).toEqual([{ type: 'paragraph' }, imageBlock(1)]);
  });

  test('posts a plain comment without touching attachments', async () => {
    await addComment.handle({ issue_key: 'KAN-1', body: 'Hello' }, context);
    expect(attachCommentImages).toHaveBeenCalledWith('KAN-1', [], [], context);
    expect(postedBody().content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]);
  });
});
