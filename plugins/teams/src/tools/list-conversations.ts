import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { nextPageToken, pageQuery } from '../chat-paging.js';
import { findChatParticipants } from '../participants.js';
import { chatApi } from '../teams-api.js';
import { conversationSchema, isChannelThreadType, mapConversation } from './schemas.js';

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    'List recent chat conversations, by last activity. A chat with no topic also lists its other `participants` by name. Use the conversation ID from results with read_messages to read messages. When `next_page_token` is returned, more conversations exist: pass it back to list them. To find a channel, use list_channels.',
  summary: 'List recent chats',
  icon: 'message-square',
  group: 'Chats',
  input: z.object({
    page_size: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of conversations per page (default 20, max 50)'),
    next_page_token: z.string().optional().describe('`next_page_token` from the previous page, to list more'),
  }),
  output: z.object({
    conversations: z.array(conversationSchema).describe('List of conversations'),
    next_page_token: z.string().nullable().describe('Token for the next page, or null when there is none'),
  }),
  handle: async params => {
    const data = await chatApi<{
      conversations?: Array<Record<string, unknown>>;
      _metadata?: { backwardLink?: string };
    }>('/v1/users/ME/conversations', {
      query: {
        ...(params.next_page_token
          ? pageQuery(params.next_page_token)
          : { view: 'superchat', startTime: 0, targetType: 'Thread|Passport' }),
        pageSize: params.page_size ?? 20,
      },
    });

    const raw = data.conversations ?? [];
    const conversations = raw.map(c => mapConversation(c as Record<string, unknown>));
    // Names only help tell chats apart, so a failed lookup leaves them out rather than failing the list.
    const participants = await findChatParticipants(
      conversations
        .filter(c => c.topic === '' && c.id.startsWith('19:') && !isChannelThreadType(c.thread_type))
        .map(c => c.id),
    ).catch(() => new Map<string, string[]>());

    return {
      conversations: conversations.map(c => ({ ...c, participants: participants.get(c.id) ?? null })),
      next_page_token: nextPageToken(data._metadata?.backwardLink, raw.length),
    };
  },
});
