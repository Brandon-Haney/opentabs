import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { issueSchema, mapIssue } from './schemas.js';

export const createIssue = defineTool({
  name: 'create_issue',
  displayName: 'Create Issue',
  description: 'Create a new issue in a repository.',
  icon: 'plus-circle',
  input: z.object({
    owner: z.string().min(1).describe('Repository owner (user or org)'),
    repo: z.string().min(1).describe('Repository name'),
    title: z.string().min(1).describe('Issue title'),
    body: z.string().optional().describe('Issue body in Markdown'),
    labels: z.array(z.string()).optional().describe('Label names to apply'),
    assignees: z.array(z.string()).optional().describe('Logins of users to assign'),
  }),
  output: z.object({
    issue: issueSchema.describe('The created issue'),
  }),
  handle: async params => {
    const body: Record<string, unknown> = { title: params.title };
    if (params.body !== undefined) body.body = params.body;
    if (params.labels !== undefined) body.labels = params.labels;
    if (params.assignees !== undefined) body.assignees = params.assignees;

    const data = await api<Record<string, unknown>>(`/repos/${params.owner}/${params.repo}/issues`, {
      method: 'POST',
      body,
    });
    return { issue: mapIssue(data) };
  },
});
