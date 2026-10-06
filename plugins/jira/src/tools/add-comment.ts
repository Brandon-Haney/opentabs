import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type AdfDoc, markdownToAdf } from './adf.js';
import { api } from '../jira-api.js';
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

export const addComment = defineTool({
  name: 'add_comment',
  displayName: 'Add Comment',
  description:
    'Add a comment to a Jira issue. The body accepts a markdown subset: headings (# … ######), bullet/ordered lists, fenced code blocks, blockquotes, **bold**, *italic*, `code`, ~~strike~~, and [links](url). Pass `body_adf` instead for full Atlassian Document Format control (mentions, panels, tables, media). Pass `parent_comment_id` to post a threaded reply. Jira threads are one level deep, so replying to a reply threads under the top-level comment of that reply. Unlike the Jira UI, a reply does not @mention the replied-to author automatically.',
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
          'Comment body in markdown. Supports headings, lists, fenced code, blockquotes, bold/italic/code/strike, and links. Required unless body_adf is provided.',
        ),
      body_adf: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Raw Atlassian Document Format JSON document ({ type: "doc", version: 1, content: [...] }). When provided, supersedes `body`. Use this for content the markdown converter does not cover (mentions, panels, tables, media).',
        ),
      parent_comment_id: z
        .string()
        .optional()
        .describe(
          'ID of the comment to reply to. The reply is threaded under that comment, or under its top-level comment when it is itself a reply. Omit for a top-level comment.',
        ),
    })
    .refine(d => (d.body !== undefined && d.body !== '') || d.body_adf !== undefined, {
      message: 'Provide either `body` (markdown) or `body_adf` (raw ADF JSON).',
    }),
  output: z.object({
    comment: commentSchema.describe('The created comment'),
  }),
  handle: async params => {
    let adf: AdfDoc;
    if (params.body_adf !== undefined) {
      if (!isAdfDoc(params.body_adf)) {
        throw ToolError.validation('body_adf must be an ADF document: { type: "doc", version: 1, content: [...] }.');
      }
      adf = params.body_adf;
    } else {
      adf = markdownToAdf(params.body ?? '');
    }
    const commentsPath = `/issue/${encodeURIComponent(params.issue_key)}/comment`;
    const parentId =
      params.parent_comment_id === undefined
        ? undefined
        : await resolveThreadRootId(commentsPath, params.parent_comment_id);
    const data = await api<Record<string, unknown>>(commentsPath, {
      method: 'POST',
      body: parentId === undefined ? { body: adf } : { body: adf, parentId },
    });
    return { comment: mapComment(data) };
  },
});
