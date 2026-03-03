import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { mapPullRequest, pullRequestSchema } from './schemas.js';

export const listPullRequests = defineTool({
  name: 'list_pull_requests',
  displayName: 'List Pull Requests',
  description: 'List pull requests for a repository with optional state and sort filters.',
  icon: 'git-pull-request',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default: open)'),
    sort: z
      .enum(['created', 'updated', 'popularity', 'long-running'])
      .optional()
      .describe('Sort field (default: created)'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction (default: desc)'),
    head: z.string().optional().describe('Filter by head branch — format: "user:ref-name" or "ref-name"'),
    base: z.string().optional().describe('Filter by base branch name'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    pull_requests: z.array(pullRequestSchema).describe('List of pull requests'),
  }),
  handle: async params => {
    const query: Record<string, string | number | boolean | undefined> = {
      state: params.state ?? 'open',
      per_page: params.per_page ?? 30,
      page: params.page,
      sort: params.sort,
      direction: params.direction,
    };
    if (params.head) query.head = params.head;
    if (params.base) query.base = params.base;

    const data = await api<Record<string, unknown>[]>(`/repos/${params.owner}/${params.repo}/pulls`, { query });
    return { pull_requests: (data ?? []).map(mapPullRequest) };
  },
});
