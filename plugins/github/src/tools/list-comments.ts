import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { commentSchema, mapComment } from './schemas.js';

export const listComments = defineTool({
  name: 'list_comments',
  displayName: 'List Comments',
  description: 'List comments on an issue or pull request.',
  icon: 'message-square',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    issue_number: z.number().int().min(1).describe('Issue or pull request number'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    comments: z.array(commentSchema).describe('List of comments'),
  }),
  handle: async params => {
    const query: Record<string, string | number | boolean | undefined> = {
      per_page: params.per_page ?? 30,
      page: params.page,
    };

    const data = await api<Record<string, unknown>[]>(
      `/repos/${params.owner}/${params.repo}/issues/${params.issue_number}/comments`,
      { query },
    );
    return { comments: (data ?? []).map(mapComment) };
  },
});
