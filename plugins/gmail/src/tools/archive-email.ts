import { gmailAction } from '../gmail-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const archiveEmail = defineTool({
  name: 'archive_email',
  displayName: 'Archive Email',
  description:
    'Archive an email thread, removing it from the inbox. ' +
    'The thread is still accessible via "All Mail" or search. ' +
    'Requires the hex thread ID (from the message_id field in read_email results).',
  summary: 'Archive an email thread',
  icon: 'archive',
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
    archived: z.boolean().describe('Whether the thread was archived'),
  }),
  handle: async params => {
    await gmailAction('rc_^i', { t: params.thread_id });
    return { archived: true };
  },
});
