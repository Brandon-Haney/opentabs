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

export const addComment = defineTool({
  name: 'add_comment',
  displayName: 'Add Comment',
  description:
    'Add a comment to a Jira issue. The body accepts a markdown subset: headings (# … ######), bullet/ordered lists, fenced code blocks, blockquotes, **bold**, *italic*, `code`, ~~strike~~, and [links](url). Pass `body_adf` instead for full Atlassian Document Format control (mentions, panels, tables, media). Note: Jira Cloud does not currently expose threaded-comment replies via its REST API — replies appear as flat comments.',
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
    const data = await api<Record<string, unknown>>(`/issue/${encodeURIComponent(params.issue_key)}/comment`, {
      method: 'POST',
      body: { body: adf },
    });
    return { comment: mapComment(data) };
  },
});
