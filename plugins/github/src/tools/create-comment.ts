import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { commentSchema, mapComment } from './schemas.js';

export const createComment = defineTool({
  name: 'create_comment',
  displayName: 'Create Comment',
  description: 'Add a comment to an issue or pull request.',
  icon: 'message-square-plus',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    issue_number: z.number().int().min(1).describe('Issue or pull request number'),
    body: z.string().min(1).describe('Comment body in Markdown'),
  }),
  output: z.object({
    comment: commentSchema.describe('The created comment'),
  }),
  handle: async params => {
    const data = await api<Record<string, unknown>>(
      `/repos/${params.owner}/${params.repo}/issues/${params.issue_number}/comments`,
      { method: 'POST', body: { body: params.body } },
    );
    return { comment: mapComment(data) };
  },
});
