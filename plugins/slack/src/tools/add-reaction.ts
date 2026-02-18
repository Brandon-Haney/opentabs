import { slackApi } from '../slack-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const addReaction = defineTool({
  name: 'add_reaction',
  description: 'Add an emoji reaction to a Slack message',
  input: z.object({
    channel: z.string().min(1).describe('Channel ID where the message is located (e.g., C01234567)'),
    timestamp: z
      .string()
      .min(1)
      .describe('Timestamp of the message to react to — serves as the unique message ID (e.g., 1234567890.123456)'),
    name: z.string().min(1).describe('Emoji name without colons (e.g., thumbsup, heart, rocket)'),
  }),
  output: z.object({}),
  handle: async params => {
    await slackApi<Record<string, never>>('reactions.add', {
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.name.replace(/^:|:$/g, ''),
    });
    return {};
  },
});
