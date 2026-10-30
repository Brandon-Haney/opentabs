import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { nextPageToken, pageQuery } from '../chat-paging.js';
import { chatApi } from '../teams-api.js';
import { mapMessage, messageSchema } from './schemas.js';

/** Compose time in milliseconds. A message's position follows when it was written, not when it was last edited. */
const composedAt = (composeTime: string): number => Date.parse(composeTime) || 0;

export const readMessages = defineTool({
  name: 'read_messages',
  displayName: 'Read Messages',
  description:
    'Read messages from a chat conversation, newest first by when each was written. Use the conversation ID from list_conversations. When `next_page_token` is returned, older messages exist: pass it back to read them. A deleted message appears with `deleted` true and no content, and an edited one carries `edited_at`.',
  summary: 'Read messages from a chat',
  icon: 'message-square',
  group: 'Messages',
  input: z.object({
    conversation_id: z.string().min(1).describe('Conversation/thread ID to read messages from'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Number of messages per page (default 20, max 200). Calls and membership events count toward it.'),
    next_page_token: z.string().optional().describe('`next_page_token` from the previous page, to read older messages'),
  }),
  output: z.object({
    messages: z.array(messageSchema).describe('List of messages (newest first)'),
    next_page_token: z.string().nullable().describe('Token for the next, older page, or null when there is none'),
  }),
  handle: async params => {
    const data = await chatApi<{
      messages?: Array<Record<string, unknown>>;
      _metadata?: { backwardLink?: string };
    }>(`/v1/users/ME/conversations/${encodeURIComponent(params.conversation_id)}/messages`, {
      query: {
        ...(params.next_page_token ? pageQuery(params.next_page_token) : {}),
        pageSize: params.page_size ?? 20,
      },
    });

    const raw = data.messages ?? [];
    const messages = raw
      .filter(m => {
        const msgType = m.messagetype as string | undefined;
        return msgType === 'RichText/Html' || msgType === 'Text' || msgType === 'RichText';
      })
      .map(m => mapMessage(m as Record<string, unknown>))
      .sort((a, b) => composedAt(b.compose_time) - composedAt(a.compose_time));

    return { messages, next_page_token: nextPageToken(data._metadata?.backwardLink, raw.length) };
  },
});
