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

export const listEmails = defineTool({
  name: 'list_emails',
  displayName: 'List Emails',
  description:
    'List recent email threads from Gmail via the internal sync API. ' +
    'Returns threads with sender, subject, snippet, timestamp, read/starred status, and labels. ' +
    'Use search_emails for filtered results.',
  summary: 'List recent email threads from Gmail',
  icon: 'inbox',
  group: 'Reading',
  input: z.object({}),
  output: z.object({
    emails: z.array(threadSummarySchema).describe('List of email threads'),
    count: z.number().describe('Number of emails returned'),
  }),
  handle: async () => {
    // Request thread list via sync API — a minimal sync poll
    const resp = await gmailSync([null, null, [1, 0, null, null, [null, 0], null, 1], null, 2], { rt: 'r', pt: 'ji' });

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
    };
  },
});
