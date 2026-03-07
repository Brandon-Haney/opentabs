import { gmailAction } from '../gmail-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const markAsUnread = defineTool({
  name: 'mark_as_unread',
  displayName: 'Mark as Unread',
  description:
    'Mark an email thread as unread. ' +
    'Requires the hex thread ID (from the message_id field in read_email results).',
  summary: 'Mark an email thread as unread',
  icon: 'mail',
  group: 'Actions',
  input: z.object({
    thread_id: z
      .string()
      .min(1)
      .describe(
        'Thread ID in hex format (e.g., "19cc44d27980d14e"). ' +
          'Get this from the message_id field when reading an email.',
      ),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the mark-as-unread operation succeeded'),
  }),
  handle: async params => {
    await gmailAction('ur', { t: params.thread_id });
    return { success: true };
  },
});
