import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../jira-api.js';
import { resolveCustomFields } from './custom-fields.js';
import { ISSUE_FIELDS, issueSchema, mapIssue } from './schemas.js';

export const searchIssues = defineTool({
  name: 'search_issues',
  displayName: 'Search Issues',
  description:
    'Search for Jira issues using JQL (Jira Query Language). Supports filtering by project, status, assignee, labels, and more. Results include the standard fields; pass `custom_fields` to add custom fields by name (get_issue shows the names an issue has). When `next_page_token` is returned, pass it back to get the next page.',
  summary: 'Search issues using JQL',
  icon: 'search',
  group: 'Issues',
  input: z.object({
    jql: z.string().describe('JQL query string (e.g. "project = KAN AND status = \'In Progress\'")'),
    max_results: z.number().optional().describe('Maximum number of results per page (default 20, max 100)'),
    next_page_token: z.string().optional().describe('`next_page_token` from the previous page, to get the next page'),
    custom_fields: z
      .array(z.string())
      .optional()
      .describe('Custom fields to include, by name or id (e.g. ["Story Points", "ServiceNow Number"])'),
  }),
  output: z.object({
    issues: z.array(issueSchema).describe('Matching issues on this page'),
    approximate_total: z
      .number()
      .nullable()
      .describe('Approximate number of issues matching the query across all pages, or null if Jira did not report it'),
    next_page_token: z.string().nullable().describe('Token for the next page, or null when this is the last page'),
  }),
  handle: async params => {
    const customFields = await resolveCustomFields(params.custom_fields ?? []);
    const [data, approximateTotal] = await Promise.all([
      api<{ issues?: Record<string, unknown>[]; nextPageToken?: string }>('/search/jql', {
        query: {
          jql: params.jql,
          maxResults: params.max_results ?? 20,
          nextPageToken: params.next_page_token,
          fields: [...ISSUE_FIELDS, ...customFields.keys()].join(','),
        },
      }),
      // The count is informational, so a failure leaves it null and the results stand.
      api<{ count?: number }>('/search/approximate-count', { method: 'POST', body: { jql: params.jql } }).then(
        result => result.count ?? null,
        () => null,
      ),
    ]);
    return {
      issues: (data.issues ?? []).map(issue => mapIssue(issue, customFields)),
      approximate_total: approximateTotal,
      next_page_token: data.nextPageToken ?? null,
    };
  },
});
