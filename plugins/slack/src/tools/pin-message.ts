import { slackApi } from '../slack-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const pinMessage = defineTool({
  name: 'pin_message',
  description: 'Pin a message to a Slack channel',
  input: z.object({
    channel: z.string().min(1).describe('Channel ID where the message is located (e.g., C01234567)'),
    timestamp: z.string().min(1).describe('Timestamp of the message to pin (e.g., 1234567890.123456)'),
  }),
  output: z.object({}),
  handle: async params => {
    await slackApi<Record<string, never>>('pins.add', {
      channel: params.channel,
      timestamp: params.timestamp,
    });
    return {};
  },
});
