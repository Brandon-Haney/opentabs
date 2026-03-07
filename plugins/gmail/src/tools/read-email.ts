import { gmailSync, htmlToText, parseThreadsFromSyncResponse } from '../gmail-api.js';
import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { messageSchema } from './schemas.js';

export const readEmail = defineTool({
  name: 'read_email',
  displayName: 'Read Email',
  description:
    'Read an email thread via the Gmail sync API. ' +
    'Returns messages in the thread with sender, recipients, subject, text snippet, and metadata. ' +
    'Requires a thread ID (e.g., "thread-f:1858936416969478478") from list_emails or search_emails.',
  summary: 'Read an email thread',
  icon: 'mail-open',
  group: 'Reading',
  input: z.object({
    thread_id: z
      .string()
      .min(1)
      .describe('Thread ID (e.g., "thread-f:1858936416969478478"). Get this from list_emails or search_emails.'),
  }),
  output: z.object({
    thread_id: z.string().describe('Thread ID'),
    subject: z.string().describe('Email subject line'),
    messages: z.array(messageSchema).describe('All messages in the thread, ordered chronologically'),
    message_count: z.number().describe('Number of messages in the thread'),
  }),
  handle: async params => {
    // Use the standard sync poll — it returns recent threads including the target
    const resp = await gmailSync([null, null, [1, 0, null, null, [null, 0], null, 1], null, 2], { rt: 'r', pt: 'ji' });

    const threads = parseThreadsFromSyncResponse(resp);
    const thread = threads.find(t => t.threadId === params.thread_id);

    if (!thread) {
      throw ToolError.notFound(
        `Thread "${params.thread_id}" not found in recent sync data. ` +
          'The thread may be too old or archived. Try search_emails to find it.',
      );
    }

    return {
      thread_id: thread.threadId,
      subject: thread.subject,
      messages: thread.messages.map(m => ({
        message_id: m.messageId,
        hex_id: m.hexId,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        snippet: m.snippet,
        body: htmlToText(m.bodyHtml) || m.snippet,
        timestamp: m.timestamp,
        labels: m.labels,
      })),
      message_count: thread.messages.length,
    };
  },
});
