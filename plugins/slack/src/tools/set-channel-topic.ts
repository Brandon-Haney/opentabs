import { slackApi } from '../slack-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const setChannelTopic = defineTool({
  name: 'set_channel_topic',
  description: 'Set the topic of a Slack channel',
  input: z.object({
    channel: z.string().min(1).describe('Channel ID to set the topic for (e.g., C01234567)'),
    topic: z.string().min(1).max(250).describe('New topic text for the channel (max 250 chars)'),
  }),
  output: z.object({
    topic: z
      .object({
        value: z.string().describe('The topic text that was set'),
        creator: z.string().describe('User ID who set the topic'),
        last_set: z.number().describe('Unix timestamp of when the topic was last set'),
      })
      .describe('Topic metadata'),
  }),
  handle: async params => {
    const data = await slackApi<{
      topic: { value?: string; creator?: string; last_set?: number };
    }>('conversations.setTopic', {
      channel: params.channel,
      topic: params.topic,
    });
    return {
      topic: {
        value: data.topic.value ?? params.topic,
        creator: data.topic.creator ?? '',
        last_set: data.topic.last_set ?? 0,
      },
    };
  },
});
