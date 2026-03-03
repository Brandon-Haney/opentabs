import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { issueSchema, mapIssue } from './schemas.js';

export const getIssue = defineTool({
  name: 'get_issue',
  displayName: 'Get Issue',
  description: 'Get detailed information about a specific issue, including its full body.',
  icon: 'circle-dot',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    issue_number: z.number().int().min(1).describe('Issue number'),
  }),
  output: z.object({
    issue: issueSchema.describe('Issue details'),
  }),
  handle: async params => {
    const data = await api<Record<string, unknown>>(
      `/repos/${params.owner}/${params.repo}/issues/${params.issue_number}`,
    );
    return { issue: mapIssue(data) };
  },
});
