import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../jira-api.js';
import { customFieldNamesFromExpand } from './custom-fields.js';
import { issueSchema, mapIssue } from './schemas.js';

export const getIssue = defineTool({
  name: 'get_issue',
  displayName: 'Get Issue',
  description:
    'Get detailed information about a specific Jira issue by its key (e.g. KAN-1) or ID, including due date, parent, subtasks, linked issues, attachments, versions, and every custom field that has a value (sprint, story points, and so on). Comments are not included; use list_comments.',
  summary: 'Get details of an issue',
  icon: 'file-text',
  group: 'Issues',
  input: z.object({
    issue_key: z.string().describe('Issue key (e.g. "KAN-1") or issue ID'),
  }),
  output: z.object({
    issue: issueSchema.describe('The issue details'),
  }),
  handle: async params => {
    const data = await api<
      Record<string, unknown> & {
        names?: Record<string, string>;
        schema?: Record<string, { custom?: string }>;
      }
    >(`/issue/${encodeURIComponent(params.issue_key)}`, {
      query: { fields: '*all,-comment,-worklog', expand: 'names,schema' },
    });
    return { issue: mapIssue(data, customFieldNamesFromExpand(data.names, data.schema)) };
  },
});
