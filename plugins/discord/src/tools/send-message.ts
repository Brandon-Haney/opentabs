import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { discordApi } from '../discord-api.js';
import { mapMessage, messageSchema } from './schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description: 'Send a message to a Discord channel',
  icon: 'send',
  input: z.object({
    channel: z.string().describe('Channel ID to send the message to'),
    content: z.string().describe('Message text content'),
    reply_to: z.string().optional().describe('Message ID to reply to (creates a threaded reply)'),
  }),
  output: z.object({
    message: messageSchema.describe('The sent message'),
  }),
  handle: async params => {
    const body: Record<string, unknown> = { content: params.content };
    if (params.reply_to) {
      body.message_reference = { message_id: params.reply_to };
    }
    const data = await discordApi<Record<string, unknown>>(`/channels/${params.channel}/messages`, {
      method: 'POST',
      body,
    });
    return { message: mapMessage(data) };
  },
});
