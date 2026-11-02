import type { LocalFile, ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as attachments from '../attachments.js';
import * as jiraApi from '../jira-api.js';
import type { AdfDoc, AdfNode } from './adf.js';
import { updateComment } from './update-comment.js';

vi.mock('../jira-api.js', () => ({ api: vi.fn() }));
vi.mock('../attachments.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../attachments.js')>()),
  attachCommentImages: vi.fn(),
}));

const api = vi.mocked(jiraApi.api);
const attachCommentImages = vi.mocked(attachments.attachCommentImages);

const ME = '557058:me';
const COMMENT_PATH = '/issue/KAN-1/comment/100';

const png = (name: string): LocalFile => ({ name, size: 3, contentType: 'image/png', contentBase64: 'AAAA' });

const context: ToolHandlerContext = {
  reportProgress: vi.fn(),
  localFile: path => png(path.split('/').pop() ?? path),
};

const shownImage = (id: string): AdfNode => ({
  type: 'mediaSingle',
  content: [{ type: 'media', attrs: { type: 'file', id, collection: '' } }],
});
const fileCard: AdfNode = { type: 'mediaGroup', content: [{ type: 'media', attrs: { type: 'file', id: 'f1' } }] };

const paragraph = (text: string): AdfNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** Serve GETs of the comment and of /myself, and echo the PUT body back as the saved comment. */
const serve = (stored: Record<string, unknown>) => {
  api.mockImplementation(async (endpoint, options) => {
    if (endpoint === '/myself') return { accountId: ME };
    if (options?.method === 'PUT') {
      return { id: '100', author: stored.author, ...(options.body as Record<string, unknown>) };
    }
    return stored;
  });
};

const ownComment = (content: AdfNode[], extra: Record<string, unknown> = {}) => ({
  id: '100',
  author: { accountId: ME, displayName: 'Me' },
  body: { type: 'doc', version: 1, content },
  ...extra,
});

const putCall = () => api.mock.calls.find(([, options]) => options?.method === 'PUT');
const putBody = (): AdfDoc => (putCall()?.[1]?.body as { body: AdfDoc }).body;

beforeEach(() => {
  api.mockReset();
  attachCommentImages.mockReset();
  attachCommentImages.mockImplementation(async (_key, images) =>
    images.map((_, i) => ({ type: 'mediaSingle', attrs: { added: i + 1 } })),
  );
});

describe('update_comment', () => {
  test('refuses a comment someone else wrote, without changing it', async () => {
    serve({ id: '100', author: { accountId: '557058:other', displayName: 'Dana Lee' }, body: { type: 'doc' } });

    await expect(updateComment.handle({ issue_key: 'KAN-1', comment_id: '100', body: 'New text' })).rejects.toThrow(
      'Comment 100 was written by Dana Lee. update_comment edits only comments you wrote.',
    );
    expect(putCall()).toBeUndefined();
  });

  test('replaces the body, keeping a mention written as @[Name](account id), and notifies by default', async () => {
    serve(ownComment([paragraph('Old text')]));

    const result = await updateComment.handle({
      issue_key: 'KAN-1',
      comment_id: '100',
      body: '@[Abhi K](712020:xyz) the export moved to Friday.',
    });

    expect(putCall()?.[0]).toBe(COMMENT_PATH);
    expect(putCall()?.[1]?.query).toEqual({ notifyUsers: true });
    expect(putBody().content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { id: '712020:xyz', text: '@Abhi K' } },
          { type: 'text', text: ' the export moved to Friday.' },
        ],
      },
    ]);
    expect(result.comment.body_text).toBe('@[Abhi K](712020:xyz) the export moved to Friday.');
  });

  test('edits without notifying watchers when notify_users is false', async () => {
    serve(ownComment([paragraph('Old text')]));

    await updateComment.handle({ issue_key: 'KAN-1', comment_id: '100', body: 'Fixed typo', notify_users: false });

    expect(putCall()?.[1]?.query).toEqual({ notifyUsers: false });
  });

  test('keeps the images and files the comment shows after the new body, unless the body places them', async () => {
    serve(ownComment([paragraph('Before'), shownImage('m1'), paragraph('Between'), shownImage('m2'), fileCard]));

    await updateComment.handle(
      {
        issue_key: 'KAN-1',
        comment_id: '100',
        body: 'Intro\n\n![second](existing:2)\n\nOutro',
        images: [{ path: '/tmp/new.png' }],
      },
      context,
    );

    expect(putBody().content).toEqual([
      paragraph('Intro'),
      shownImage('m2'),
      paragraph('Outro'),
      shownImage('m1'),
      fileCard,
      { type: 'mediaSingle', attrs: { added: 1 } },
    ]);
  });

  test('refuses an existing image number the comment does not have, before uploading anything', async () => {
    serve(ownComment([paragraph('Text'), shownImage('m1')]));

    await expect(
      updateComment.handle(
        {
          issue_key: 'KAN-1',
          comment_id: '100',
          body: '![x](existing:2)',
          images: [{ path: '/tmp/new.png' }],
        },
        context,
      ),
    ).rejects.toThrow('the comment shows 1 image(s)');
    expect(attachCommentImages).not.toHaveBeenCalled();
    expect(putCall()).toBeUndefined();
  });

  test('sends a restricted comment back with its visibility', async () => {
    const visibility = { type: 'role', value: 'Developers' };
    serve(ownComment([paragraph('Internal')], { visibility }));

    await updateComment.handle({ issue_key: 'KAN-1', comment_id: '100', body: 'Still internal' });

    expect((putCall()?.[1]?.body as { visibility?: unknown }).visibility).toEqual(visibility);
  });

  test('replaces the whole comment with body_adf, dropping what it showed', async () => {
    serve(ownComment([paragraph('Old'), shownImage('m1')]));
    const doc = { type: 'doc', version: 1, content: [paragraph('Only this')] };

    await updateComment.handle({ issue_key: 'KAN-1', comment_id: '100', body_adf: doc });

    expect(putBody()).toEqual(doc);
  });
});
