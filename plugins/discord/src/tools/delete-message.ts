import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { discordApi } from '../discord-api.js';

export const deleteMessage = defineTool({
  name: 'delete_message',
  displayName: 'Delete Message',
  description: 'Delete a message from a channel',
  icon: 'trash-2',
  input: z.object({
    channel: z.string().describe('Channel ID where the message is located'),
    message_id: z.string().describe('ID of the message to delete'),
  }),
  output: z.object({}),
  handle: async params => {
    await discordApi(`/channels/${params.channel}/messages/${params.message_id}`, {
      method: 'DELETE',
    });
    return {};
  },
});
