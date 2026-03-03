import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { mapPullRequest, pullRequestSchema } from './schemas.js';

export const createPullRequest = defineTool({
  name: 'create_pull_request',
  displayName: 'Create Pull Request',
  description: 'Create a new pull request.',
  icon: 'git-pull-request-arrow',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    title: z.string().min(1).describe('Pull request title'),
    head: z.string().min(1).describe('Source branch name (or "user:branch" for cross-repo)'),
    base: z.string().min(1).describe('Target branch name to merge into'),
    body: z.string().optional().describe('Pull request description in Markdown'),
    draft: z.boolean().optional().describe('Create as a draft PR (default: false)'),
  }),
  output: z.object({
    pull_request: pullRequestSchema.describe('The created pull request'),
  }),
  handle: async params => {
    const body: Record<string, unknown> = {
      title: params.title,
      head: params.head,
      base: params.base,
    };
    if (params.body !== undefined) body.body = params.body;
    if (params.draft !== undefined) body.draft = params.draft;

    const data = await api<Record<string, unknown>>(`/repos/${params.owner}/${params.repo}/pulls`, {
      method: 'POST',
      body,
    });
    return { pull_request: mapPullRequest(data) };
  },
});
