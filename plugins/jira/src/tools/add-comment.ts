import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachCommentImages, commentImageInputSchema, readCommentImages } from '../attachments.js';
import { api } from '../jira-api.js';
import { buildCommentDoc } from './comment-body.js';
import { commentSchema, mapComment } from './schemas.js';

/** Jira threads are one level deep: a reply to a reply is posted under the thread's top-level comment. */
const resolveThreadRootId = async (commentsPath: string, commentId: string): Promise<number> => {
  const parent = await api<{ id?: string; parentId?: number | string }>(
    `${commentsPath}/${encodeURIComponent(commentId)}`,
  );
  return Number(parent.parentId ?? parent.id ?? commentId);
};

export const addComment = defineTool({
  name: 'add_comment',
  displayName: 'Add Comment',
  description:
    'Add a comment to a Jira issue. The body accepts a markdown subset: headings, bullet/ordered lists, fenced code, blockquotes, **bold**, *italic*, `code`, ~~strike~~, [links](url), @[Display Name](account id) mentions, and <u>underline</u> or the other tags body_text uses for formatting markdown lacks. Pass `images` to show image files from this computer in the comment: each is uploaded as an issue attachment and shown inline. A line holding only `![alt](image:N)` places the Nth image (counted from 1) there; images the body does not place follow it. Pass `body_adf` instead for full Atlassian Document Format control (panels, tables); images then follow the document. Pass `parent_comment_id` to post a threaded reply, under the top-level comment when replying to a reply, since Jira threads are one level deep. Unlike the Jira UI, a reply does not @mention the replied-to author automatically. If the comment fails after its images uploaded, the images stay attached to the issue.',
  summary: 'Add a comment to an issue',
  icon: 'message-square',
  group: 'Comments',
  input: z
    .object({
      issue_key: z.string().describe('Issue key (e.g. "KAN-1") or issue ID'),
      body: z
        .string()
        .optional()
        .describe(
          'Comment body in markdown. Supports headings, lists, fenced code, blockquotes, bold/italic/code/strike, links, @[Display Name](account id) mentions, and `![alt](image:N)` lines placing the Nth entry of `images`. Required unless body_adf or images is provided.',
        ),
      body_adf: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Raw Atlassian Document Format JSON document ({ type: "doc", version: 1, content: [...] }). When provided, supersedes `body`. Use this for content the markdown converter does not cover (panels, tables).',
        ),
      images: z
        .array(commentImageInputSchema)
        .optional()
        .describe(
          'Image files on this computer to show in the comment, in order. Each is uploaded as an attachment of the issue.',
        ),
      parent_comment_id: z
        .string()
        .optional()
        .describe(
          'ID of the comment to reply to. The reply is threaded under that comment, or under its top-level comment when it is itself a reply. Omit for a top-level comment.',
        ),
    })
    .refine(
      d => (d.body !== undefined && d.body.trim() !== '') || d.body_adf !== undefined || (d.images?.length ?? 0) > 0,
      { message: 'Provide `body` (markdown), `body_adf` (raw ADF JSON), or `images`.' },
    ),
  output: z.object({
    comment: commentSchema.describe('The created comment'),
  }),
  handle: async (params, context) => {
    const images = params.images ?? [];
    const imageFiles = readCommentImages(context, images);
    // Check the body and its image references before anything is uploaded.
    buildCommentDoc(params, { added: images.map(() => ({ type: 'mediaSingle' })) });

    const commentsPath = `/issue/${encodeURIComponent(params.issue_key)}/comment`;
    const parentId =
      params.parent_comment_id === undefined
        ? undefined
        : await resolveThreadRootId(commentsPath, params.parent_comment_id);

    const imageBlocks = await attachCommentImages(params.issue_key, images, imageFiles, context);
    const adf = buildCommentDoc(params, { added: imageBlocks });
    if (imageFiles.length > 0) {
      context?.reportProgress({
        progress: imageFiles.length,
        total: imageFiles.length,
        message: 'Posting the comment',
      });
    }
    const data = await api<Record<string, unknown>>(commentsPath, {
      method: 'POST',
      body: parentId === undefined ? { body: adf } : { body: adf, parentId },
    });
    return { comment: mapComment(data) };
  },
});
