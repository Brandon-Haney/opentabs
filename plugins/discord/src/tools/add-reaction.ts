import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { discordApi } from '../discord-api.js';

export const addReaction = defineTool({
  name: 'add_reaction',
  displayName: 'Add Reaction',
  description: 'Add an emoji reaction to a message',
  icon: 'smile-plus',
  input: z.object({
    channel: z.string().describe('Channel ID where the message is located'),
    message_id: z.string().describe('Message ID to react to'),
    emoji: z.string().describe('Emoji to react with — use Unicode emoji (e.g., "👍") or custom emoji format "name:id"'),
  }),
  output: z.object({}),
  handle: async params => {
    const emoji = encodeURIComponent(params.emoji);
    await discordApi(`/channels/${params.channel}/messages/${params.message_id}/reactions/${emoji}/@me`, {
      method: 'PUT',
    });
    return {};
  },
});
