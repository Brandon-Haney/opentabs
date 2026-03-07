import { gmailAction } from '../gmail-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const starEmail = defineTool({
  name: 'star_email',
  displayName: 'Star Email',
  description:
    'Star or unstar an email thread. Starred emails appear in the Starred view. ' +
    'Requires the hex thread ID (from the message_id field in read_email results).',
  summary: 'Star or unstar an email thread',
  icon: 'star',
  group: 'Actions',
  input: z.object({
    thread_id: z
      .string()
      .min(1)
      .describe(
        'Thread ID in hex format (e.g., "19cc44d27980d14e"). ' +
          'Get this from the message_id field when reading an email.',
      ),
    starred: z.boolean().describe('true to star the thread, false to unstar it'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the star operation succeeded'),
  }),
  handle: async params => {
    const action = params.starred ? 'st' : 'xst';
    await gmailAction(action, { t: params.thread_id });
    return { success: true };
  },
});
