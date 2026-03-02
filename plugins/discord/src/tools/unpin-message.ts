import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { discordApi } from '../discord-api.js';

export const unpinMessage = defineTool({
  name: 'unpin_message',
  displayName: 'Unpin Message',
  description: 'Unpin a message from a channel. Requires Manage Messages permission.',
  icon: 'pin-off',
  input: z.object({
    channel: z.string().describe('Channel ID where the message is located'),
    message_id: z.string().describe('Message ID to unpin'),
  }),
  output: z.object({}),
  handle: async params => {
    await discordApi(`/channels/${params.channel}/pins/${params.message_id}`, {
      method: 'DELETE',
    });
    return {};
  },
});
