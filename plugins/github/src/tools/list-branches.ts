import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { branchSchema, mapBranch } from './schemas.js';

export const listBranches = defineTool({
  name: 'list_branches',
  displayName: 'List Branches',
  description: 'List branches for a repository.',
  icon: 'git-branch',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    branches: z.array(branchSchema).describe('List of branches'),
  }),
  handle: async params => {
    const query: Record<string, string | number | boolean | undefined> = {
      per_page: params.per_page ?? 30,
      page: params.page,
    };

    const data = await api<Record<string, unknown>[]>(`/repos/${params.owner}/${params.repo}/branches`, { query });
    return { branches: (data ?? []).map(mapBranch) };
  },
});
