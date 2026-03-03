import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { mapPullRequest, pullRequestSchema } from './schemas.js';

export const getPullRequest = defineTool({
  name: 'get_pull_request',
  displayName: 'Get Pull Request',
  description: 'Get detailed information about a specific pull request, including merge status and diff stats.',
  icon: 'git-pull-request',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    pull_number: z.number().int().min(1).describe('Pull request number'),
  }),
  output: z.object({
    pull_request: pullRequestSchema.describe('Pull request details'),
  }),
  handle: async params => {
    const data = await api<Record<string, unknown>>(
      `/repos/${params.owner}/${params.repo}/pulls/${params.pull_number}`,
    );
    return { pull_request: mapPullRequest(data) };
  },
});
