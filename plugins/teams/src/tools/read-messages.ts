import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { nextPageToken, pageQuery } from '../chat-paging.js';
import { directoryIdOfMri, lookUpDisplayNames } from '../participants.js';
import { chatApi } from '../teams-api.js';
import { CHAT_MESSAGE_TYPES, type Message, mapMessage, messageFormatSchema, messageSchema } from './schemas.js';

/** Compose time in milliseconds. A message's position follows when it was written, not when it was last edited. */
const composedAt = (composeTime: string): number => Date.parse(composeTime) || 0;

/** Fills in sender names the service left blank, as it does on every channel message and on some chat messages. */
const withSenderNames = async (messages: Message[]): Promise<Message[]> => {
  const unnamed = messages.filter(m => m.display_name === '').flatMap(m => directoryIdOfMri(m.from) ?? []);
  if (unnamed.length === 0) return messages;
  const names = await lookUpDisplayNames(unnamed);
  if (!names) return messages;
  return messages.map(m => {
    if (m.display_name !== '') return m;
    const id = directoryIdOfMri(m.from);
    return { ...m, display_name: (id && names.get(id.toLowerCase())) || '' };
  });
};

export const readMessages = defineTool({
  name: 'read_messages',
  displayName: 'Read Messages',
  description:
    "Read messages from a chat conversation, newest first by when each was written. Use the conversation ID from list_conversations. When `next_page_token` is returned, older messages exist: pass it back to read them. A deleted message appears with `deleted` true and no content, and an edited one carries `edited_at`. In a channel, a reply carries `reply_to_post_id`, and a post announcing a meeting carries `meeting`. Text is Markdown in the form send_message and edit_message take: mentions read @[Name], emoji as their character, images as [image] (listed in `images`), and a reply's quote card is `quoted_message` rather than text.",
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
    format: messageFormatSchema
      .optional()
      .describe('"markdown" (default) for message text as Markdown, or "html" for the HTML Teams stores'),
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
      .filter(m => CHAT_MESSAGE_TYPES.has(String(m.messagetype ?? '')))
      .map(m => mapMessage(m as Record<string, unknown>, params.format))
      .sort((a, b) => composedAt(b.compose_time) - composedAt(a.compose_time));

    return {
      messages: await withSenderNames(messages),
      next_page_token: nextPageToken(data._metadata?.backwardLink, raw.length),
    };
  },
});
