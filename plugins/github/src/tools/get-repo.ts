import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { mapRepository, repositorySchema } from './schemas.js';

export const getRepo = defineTool({
  name: 'get_repo',
  displayName: 'Get Repository',
  description: 'Get detailed information about a specific repository.',
  icon: 'book-open',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
  }),
  output: z.object({
    repository: repositorySchema.describe('Repository details'),
  }),
  handle: async params => {
    const data = await api<Record<string, unknown>>(`/repos/${params.owner}/${params.repo}`);
    return { repository: mapRepository(data) };
  },
});
