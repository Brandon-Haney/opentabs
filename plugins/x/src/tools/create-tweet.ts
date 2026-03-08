import { z } from 'zod';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { graphqlMutation } from '../x-api.js';
import { tweetSchema, mapTweet } from './schemas.js';
import type { RawTweetResult } from './schemas.js';

export const createTweet = defineTool({
  name: 'create_tweet',
  displayName: 'Create Tweet',
  description:
    'Post a new tweet. Supports plain text and replies. To reply to a tweet, provide the reply_to_tweet_id parameter.',
  summary: 'Post a new tweet',
  icon: 'send',
  group: 'Tweets',
  input: z.object({
    text: z.string().min(1).max(280).describe('Tweet text (max 280 characters)'),
    reply_to_tweet_id: z.string().optional().describe('Tweet ID to reply to'),
  }),
  output: z.object({
    tweet: tweetSchema,
  }),
  handle: async params => {
    const variables: Record<string, unknown> = {
      tweet_text: params.text,
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
    };

    if (params.reply_to_tweet_id) {
      variables.reply = {
        in_reply_to_tweet_id: params.reply_to_tweet_id,
        exclude_reply_user_ids: [],
      };
    }

    const data = await graphqlMutation<{
      data: { create_tweet: { tweet_results: { result: RawTweetResult } } };
    }>('CreateTweet', variables);

    return { tweet: mapTweet(data.data.create_tweet.tweet_results.result) };
  },
});
