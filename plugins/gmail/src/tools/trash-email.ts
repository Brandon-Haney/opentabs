import { gmailAction } from '../gmail-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const trashEmail = defineTool({
  name: 'trash_email',
  displayName: 'Trash Email',
  description:
    'Move an email thread to the Trash. The thread will be permanently deleted after 30 days. ' +
    'Requires the hex thread ID (from the message_id field in read_email results).',
  summary: 'Move an email thread to Trash',
  icon: 'trash-2',
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
    trashed: z.boolean().describe('Whether the thread was moved to Trash'),
  }),
  handle: async params => {
    await gmailAction('tr', { t: params.thread_id });
    return { trashed: true };
  },
});
