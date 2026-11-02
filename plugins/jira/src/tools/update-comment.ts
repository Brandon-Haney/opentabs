import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachCommentImages, commentImageInputSchema, readCommentImages } from '../attachments.js';
import { api } from '../jira-api.js';
import { buildCommentDoc, commentMediaBlocks } from './comment-body.js';
import { commentSchema, mapComment } from './schemas.js';

interface StoredComment {
  author?: { accountId?: string; displayName?: string };
  body?: unknown;
  visibility?: Record<string, unknown>;
}

export const updateComment = defineTool({
  name: 'update_comment',
  displayName: 'Update Comment',
  description:
    'Replace the body of a comment you wrote on a Jira issue; comments by anyone else are refused. Jira must also allow you to edit your own comments in that project. The body is markdown in the form body_text shows, so to change a comment, read it with list_comments, edit its body_text and pass the result: mentions written @[Display Name](account id) stay mentions, and formatting tags such as <u>…</u> stay formatting. Images the comment shows stay, after the new body, unless a line holding only `![alt](existing:N)` places the Nth of them (counted from 1, as [image…] appears in body_text). `images` adds image files from this computer, placed with `![alt](image:N)` like add_comment. Pass `body_adf` instead to replace the whole comment with an Atlassian Document Format document; only added images then follow it. Set notify_users to false to edit without notifying watchers.',
  summary: 'Edit a comment you wrote',
  icon: 'pencil',
  group: 'Comments',
  input: z
    .object({
      issue_key: z.string().describe('Issue key (e.g. "KAN-1") or issue ID'),
      comment_id: z.string().describe('ID of the comment to edit (from list_comments)'),
      body: z
        .string()
        .optional()
        .describe(
          'New comment body in markdown, in the form body_text shows. Supports headings, lists, fenced code, blockquotes, bold/italic/code/strike, links, @[Display Name](account id) mentions, and `![alt](image:N)` / `![alt](existing:N)` image lines. Required unless body_adf is provided.',
        ),
      body_adf: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Raw Atlassian Document Format JSON document ({ type: "doc", version: 1, content: [...] }) that replaces the whole comment. Supersedes `body`.',
        ),
      images: z
        .array(commentImageInputSchema)
        .optional()
        .describe(
          'Image files on this computer to add to the comment, in order. Each is uploaded as an attachment of the issue.',
        ),
      notify_users: z
        .boolean()
        .optional()
        .describe('Whether Jira notifies the issue watchers of the edit (default true, as in the Jira UI)'),
    })
    .refine(d => (d.body !== undefined && d.body.trim() !== '') || d.body_adf !== undefined, {
      message: 'Provide `body` (markdown) or `body_adf` (raw ADF JSON).',
    }),
  output: z.object({
    comment: commentSchema.describe('The edited comment'),
  }),
  handle: async (params, context) => {
    const images = params.images ?? [];
    const imageFiles = readCommentImages(context, images);
    const commentPath = `/issue/${encodeURIComponent(params.issue_key)}/comment/${encodeURIComponent(params.comment_id)}`;

    const [stored, myself] = await Promise.all([
      api<StoredComment>(commentPath),
      api<{ accountId?: string }>('/myself'),
    ]);
    if (!myself.accountId || stored.author?.accountId !== myself.accountId) {
      throw ToolError.validation(
        `Comment ${params.comment_id} was written by ${stored.author?.displayName || 'someone else'}. update_comment edits only comments you wrote.`,
      );
    }

    const shown = commentMediaBlocks(stored.body);
    // Check the body and its image references before anything is uploaded.
    buildCommentDoc(params, { ...shown, added: images.map(() => ({ type: 'mediaSingle' })) });

    const added = await attachCommentImages(params.issue_key, images, imageFiles, context);
    const adf = buildCommentDoc(params, { ...shown, added });
    if (imageFiles.length > 0) {
      context?.reportProgress({
        progress: imageFiles.length,
        total: imageFiles.length,
        message: 'Saving the comment',
      });
    }
    const data = await api<Record<string, unknown>>(commentPath, {
      method: 'PUT',
      query: { notifyUsers: params.notify_users ?? true },
      // Visibility is sent back as stored, so a restricted comment stays restricted.
      body: stored.visibility ? { body: adf, visibility: stored.visibility } : { body: adf },
    });
    return { comment: mapComment(data) };
  },
});
