import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, getLogin } from '../github-api.js';
import { mapRepository, repositorySchema } from './schemas.js';

export const listRepos = defineTool({
  name: 'list_repos',
  displayName: 'List Repositories',
  description:
    'List repositories for the authenticated user or a specified user/organization. Returns repos sorted by last updated.',
  icon: 'book-marked',
  input: z.object({
    owner: z.string().optional().describe('Username or org name — defaults to the authenticated user'),
    type: z
      .enum(['all', 'owner', 'public', 'private', 'member'])
      .optional()
      .describe('Type filter for user repos (default: all)'),
    sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional().describe('Sort field (default: updated)'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    repositories: z.array(repositorySchema).describe('List of repositories'),
  }),
  handle: async params => {
    const owner = params.owner ?? getLogin();
    const isOrg = params.owner !== undefined;

    const query: Record<string, string | number | boolean | undefined> = {
      per_page: params.per_page ?? 30,
      page: params.page,
      sort: params.sort ?? 'updated',
    };

    let endpoint: string;
    if (isOrg) {
      endpoint = `/users/${owner}/repos`;
      if (params.type) query.type = params.type;
    } else {
      endpoint = '/user/repos';
      if (params.type) query.type = params.type;
    }

    const data = await api<Record<string, unknown>[]>(endpoint, { query });
    return { repositories: (data ?? []).map(mapRepository) };
  },
});
