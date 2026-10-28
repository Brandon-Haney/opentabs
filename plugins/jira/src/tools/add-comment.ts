import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachCommentImages, commentImageInputSchema, readCommentImages } from '../attachments.js';
import { api } from '../jira-api.js';
import { type AdfDoc, type AdfNode, markdownToAdf } from './adf.js';
import { commentSchema, mapComment } from './schemas.js';

const isAdfDoc = (value: unknown): value is AdfDoc => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.type === 'doc' && Array.isArray(v.content);
};

/** Jira threads are one level deep: a reply to a reply is posted under the thread's top-level comment. */
const resolveThreadRootId = async (commentsPath: string, commentId: string): Promise<number> => {
  const parent = await api<{ id?: string; parentId?: number | string }>(
    `${commentsPath}/${encodeURIComponent(commentId)}`,
  );
  return Number(parent.parentId ?? parent.id ?? commentId);
};

/** A markdown image reference to the Nth entry of `images`, counted from 1. */
const IMAGE_REF = /^image:(\d+)$/;

interface CommentBodyInput {
  body?: string;
  body_adf?: Record<string, unknown>;
}

/**
 * Build the comment document with `imageBlocks[i]` standing for `images[i]`. Markdown
 * lines `![alt](image:N)` place image N there; every image the body does not place
 * follows the body, in order.
 */
const buildCommentDoc = (input: CommentBodyInput, imageBlocks: AdfNode[]): AdfDoc => {
  const placed = new Set<number>();
  let doc: AdfDoc;
  if (input.body_adf !== undefined) {
    if (!isAdfDoc(input.body_adf)) {
      throw ToolError.validation('body_adf must be an ADF document: { type: "doc", version: 1, content: [...] }.');
    }
    doc = input.body_adf;
  } else if (input.body === undefined || input.body.trim() === '') {
    doc = { type: 'doc', version: 1, content: [] };
  } else {
    doc = markdownToAdf(input.body, {
      image: ref => {
        const m = IMAGE_REF.exec(ref);
        if (!m?.[1]) return undefined;
        const index = Number(m[1]) - 1;
        const block = imageBlocks[index];
        if (!block) {
          throw ToolError.validation(
            `The body places ![…](${ref}), but ${imageBlocks.length} image(s) were passed in \`images\`.`,
          );
        }
        placed.add(index);
        return block;
      },
    });
  }
  const unplaced = imageBlocks.filter((_, index) => !placed.has(index));
  return unplaced.length ? { ...doc, content: [...doc.content, ...unplaced] } : doc;
};

export const addComment = defineTool({
  name: 'add_comment',
  displayName: 'Add Comment',
  description:
    'Add a comment to a Jira issue. The body accepts a markdown subset: headings (# … ######), bullet/ordered lists, fenced code blocks, blockquotes, **bold**, *italic*, `code`, ~~strike~~, and [links](url). Pass `images` to show image files from this computer in the comment: each is uploaded as an issue attachment and shown inline. A line holding only `![alt](image:N)` places the Nth image (counted from 1) at that point in the body; images the body does not place follow the body. Pass `body_adf` instead for full Atlassian Document Format control (mentions, panels, tables); images then follow the document. Pass `parent_comment_id` to post a threaded reply. Jira threads are one level deep, so replying to a reply threads under the top-level comment of that reply. Unlike the Jira UI, a reply does not @mention the replied-to author automatically. If the comment fails after its images uploaded, the images stay attached to the issue.',
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
          'Comment body in markdown. Supports headings, lists, fenced code, blockquotes, bold/italic/code/strike, links, and `![alt](image:N)` lines placing the Nth entry of `images`. Required unless body_adf or images is provided.',
        ),
      body_adf: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Raw Atlassian Document Format JSON document ({ type: "doc", version: 1, content: [...] }). When provided, supersedes `body`. Use this for content the markdown converter does not cover (mentions, panels, tables).',
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
    buildCommentDoc(
      params,
      images.map(() => ({ type: 'mediaSingle' })),
    );

    const commentsPath = `/issue/${encodeURIComponent(params.issue_key)}/comment`;
    const parentId =
      params.parent_comment_id === undefined
        ? undefined
        : await resolveThreadRootId(commentsPath, params.parent_comment_id);

    const imageBlocks = await attachCommentImages(params.issue_key, images, imageFiles, context);
    const adf = buildCommentDoc(params, imageBlocks);
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
