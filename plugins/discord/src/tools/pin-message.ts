import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { discordApi } from '../discord-api.js';

export const pinMessage = defineTool({
  name: 'pin_message',
  displayName: 'Pin Message',
  description: 'Pin a message in a channel. Requires Manage Messages permission.',
  icon: 'pin',
  input: z.object({
    channel: z.string().describe('Channel ID where the message is located'),
    message_id: z.string().describe('Message ID to pin'),
  }),
  output: z.object({}),
  handle: async params => {
    await discordApi(`/channels/${params.channel}/pins/${params.message_id}`, {
      method: 'PUT',
    });
    return {};
  },
});
