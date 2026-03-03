import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { issueSchema, mapIssue } from './schemas.js';

export const listIssues = defineTool({
  name: 'list_issues',
  displayName: 'List Issues',
  description:
    'List issues for a repository. By default returns open issues sorted by creation date. Can filter by state, labels, assignee, and more.',
  icon: 'circle-dot',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter (default: open)'),
    labels: z.string().optional().describe('Comma-separated list of label names to filter by'),
    assignee: z.string().optional().describe('Filter by assignee login, or "none" for unassigned, "*" for any'),
    sort: z.enum(['created', 'updated', 'comments']).optional().describe('Sort field (default: created)'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction (default: desc)'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    issues: z.array(issueSchema).describe('List of issues'),
  }),
  handle: async params => {
    const query: Record<string, string | number | boolean | undefined> = {
      state: params.state ?? 'open',
      per_page: params.per_page ?? 30,
      page: params.page,
      sort: params.sort,
      direction: params.direction,
    };
    if (params.labels) query.labels = params.labels;
    if (params.assignee) query.assignee = params.assignee;

    const data = await api<Record<string, unknown>[]>(`/repos/${params.owner}/${params.repo}/issues`, { query });
    return { issues: (data ?? []).map(mapIssue) };
  },
});
