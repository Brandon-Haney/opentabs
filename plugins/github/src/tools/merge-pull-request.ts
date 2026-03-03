import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';

export const mergePullRequest = defineTool({
  name: 'merge_pull_request',
  displayName: 'Merge Pull Request',
  description: 'Merge a pull request. Supports merge commit, squash, and rebase strategies.',
  icon: 'git-merge',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    pull_number: z.number().int().min(1).describe('Pull request number'),
    commit_title: z.string().optional().describe('Title for the merge commit'),
    commit_message: z.string().optional().describe('Extra detail for the merge commit'),
    merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge strategy (default: merge)'),
  }),
  output: z.object({
    sha: z.string().describe('SHA of the merge commit'),
    message: z.string().describe('Merge result message'),
    merged: z.boolean().describe('Whether the merge succeeded'),
  }),
  handle: async params => {
    const body: Record<string, unknown> = {};
    if (params.commit_title) body.commit_title = params.commit_title;
    if (params.commit_message) body.commit_message = params.commit_message;
    if (params.merge_method) body.merge_method = params.merge_method;

    const data = await api<{
      sha?: string;
      message?: string;
      merged?: boolean;
    }>(`/repos/${params.owner}/${params.repo}/pulls/${params.pull_number}/merge`, { method: 'PUT', body });
    return {
      sha: data.sha ?? '',
      message: data.message ?? '',
      merged: data.merged ?? false,
    };
  },
});
