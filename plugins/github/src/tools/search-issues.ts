import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { issueSchema, mapIssue } from './schemas.js';

export const searchIssues = defineTool({
  name: 'search_issues',
  displayName: 'Search Issues',
  description:
    'Search issues and pull requests across GitHub. Uses GitHub search syntax — e.g., "repo:owner/name is:open label:bug".',
  icon: 'search',
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Search query using GitHub search syntax (e.g., "repo:owner/name is:open label:bug", "org:myorg is:pr is:merged")',
      ),
    sort: z
      .enum(['comments', 'reactions', 'reactions-+1', 'reactions--1', 'interactions', 'created', 'updated'])
      .optional()
      .describe('Sort field'),
    order: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc)'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    total_count: z.number().describe('Total number of matching results'),
    issues: z.array(issueSchema).describe('List of matching issues/PRs'),
  }),
  handle: async params => {
    const query: Record<string, string | number | boolean | undefined> = {
      q: params.query,
      per_page: params.per_page ?? 30,
      page: params.page,
    };
    if (params.sort) query.sort = params.sort;
    if (params.order) query.order = params.order;

    const data = await api<{
      total_count?: number;
      items?: Record<string, unknown>[];
    }>('/search/issues', { query });
    return {
      total_count: data.total_count ?? 0,
      issues: (data.items ?? []).map(mapIssue),
    };
  },
});
