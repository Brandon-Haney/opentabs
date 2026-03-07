import {
  formatLabelName,
  gmailSync,
  htmlToText,
  isStarred,
  isUnread,
  parseThreadsFromSyncResponse,
} from '../gmail-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { threadSummarySchema } from './schemas.js';

export const searchEmails = defineTool({
  name: 'search_emails',
  displayName: 'Search Emails',
  description:
    'Search emails using Gmail search syntax via the internal sync API. Supports all Gmail search operators: ' +
    '"from:user@example.com", "to:me", "subject:invoice", "has:attachment", ' +
    '"is:unread", "is:starred", "label:work", "after:2024/01/01", "before:2024/12/31", ' +
    '"newer_than:7d", "older_than:1m", etc. Returns matching threads.',
  summary: 'Search emails using Gmail search operators',
  icon: 'search',
  group: 'Reading',
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Gmail search query (e.g., "from:boss@company.com is:unread", "subject:meeting after:2024/01/01")'),
  }),
  output: z.object({
    emails: z.array(threadSummarySchema).describe('Search results'),
    count: z.number().describe('Number of results returned'),
    query: z.string().describe('The search query that was executed'),
  }),
  handle: async params => {
    const resp = await gmailSync([null, null, [1, 0, null, null, [null, 0], null, 1], null, 2], {
      rt: 'r',
      pt: 'ji',
      q: params.query,
    });

    const threads = parseThreadsFromSyncResponse(resp);

    return {
      emails: threads.map(t => ({
        thread_id: t.threadId,
        subject: t.subject,
        snippet: htmlToText(t.snippet),
        from: t.from,
        timestamp: t.timestamp,
        is_unread: isUnread(t.labels),
        is_starred: isStarred(t.labels),
        labels: t.labels.map(formatLabelName),
        message_count: t.messages.length,
      })),
      count: threads.length,
      query: params.query,
    };
  },
});
