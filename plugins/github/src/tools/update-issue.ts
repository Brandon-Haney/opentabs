import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { issueSchema, mapIssue } from './schemas.js';

export const updateIssue = defineTool({
  name: 'update_issue',
  displayName: 'Update Issue',
  description: 'Update an existing issue — change title, body, state, labels, or assignees.',
  icon: 'pencil',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    issue_number: z.number().int().min(1).describe('Issue number'),
    title: z.string().optional().describe('New issue title'),
    body: z.string().optional().describe('New issue body in Markdown'),
    state: z.enum(['open', 'closed']).optional().describe('Set issue state'),
    labels: z.array(z.string()).optional().describe('Replace all labels with these names'),
    assignees: z.array(z.string()).optional().describe('Replace all assignees with these logins'),
  }),
  output: z.object({
    issue: issueSchema.describe('The updated issue'),
  }),
  handle: async params => {
    const body: Record<string, unknown> = {};
    if (params.title !== undefined) body.title = params.title;
    if (params.body !== undefined) body.body = params.body;
    if (params.state !== undefined) body.state = params.state;
    if (params.labels !== undefined) body.labels = params.labels;
    if (params.assignees !== undefined) body.assignees = params.assignees;

    const data = await api<Record<string, unknown>>(
      `/repos/${params.owner}/${params.repo}/issues/${params.issue_number}`,
      { method: 'PATCH', body },
    );
    return { issue: mapIssue(data) };
  },
});
