import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { composeMessage } from '../compose-message.js';
import { MARKDOWN_FORMATTING_HELP } from '../markdown-html.js';
import { openingQuoteCard } from '../reply-quote.js';
import { chatApi } from '../teams-api.js';
import { CHAT_MESSAGE_TYPES, type RawMessage } from './schemas.js';

/**
 * Message properties an edit carries over unchanged: the quote card's link to
 * the message it quotes, attached files, link previews and cards. Mentions are
 * set from the new text instead.
 */
const KEPT_PROPERTIES = ['qtdMsgs', 'files', 'links', 'cards'] as const;

const keptProperties = (message: RawMessage): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const name of KEPT_PROPERTIES) {
    const value = message.properties?.[name];
    if (typeof value === 'string' && value !== '') kept[name] = value;
  }
  return kept;
};

export const editMessage = defineTool({
  name: 'edit_message',
  displayName: 'Edit Message',
  description:
    'Edit a message you sent in a Teams chat. Pass the text as read_messages returns it: @[Name] mentions as in ' +
    'send_message, a reply keeps its quote card (quoted_message), and files and link previews stay. ' +
    MARKDOWN_FORMATTING_HELP,
  summary: 'Edit a chat message',
  icon: 'pencil',
  group: 'Messages',
  input: z.object({
    conversation_id: z.string().min(1).describe('Conversation/thread ID'),
    message_id: z.string().min(1).describe('Message ID to edit'),
    text: z.string().min(1).describe('New message text in Markdown; @[Name] mentions a person, as in send_message'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the edit was successful'),
    mentions: z
      .array(
        z.object({
          text: z.string().describe('The text the mention shows'),
          display_name: z.string().describe('Who it resolved to'),
          email: z.string().describe('Their email'),
        }),
      )
      .describe('Each mention in the edited message, in order'),
  }),
  handle: async (params, context) => {
    const messagePath = `/v1/users/ME/conversations/${encodeURIComponent(params.conversation_id)}/messages/${encodeURIComponent(params.message_id)}`;
    const original = await chatApi<RawMessage>(messagePath);
    if (original.properties?.deletetime) {
      throw ToolError.validation(`Message ${params.message_id} was deleted, so it cannot be edited.`);
    }
    if (!CHAT_MESSAGE_TYPES.has(original.messagetype ?? '')) {
      throw ToolError.validation(
        `Message ${params.message_id} is a ${original.messagetype ?? 'system'} event, not a chat message, so it cannot be edited.`,
      );
    }

    const composed = await composeMessage(
      { conversationId: params.conversation_id, text: params.text, files: [], fileAccess: 'view' },
      context,
    );
    const quoteCard = openingQuoteCard(original.content ?? '');
    // Mentions are always sent, empty when the new text has none, so a mention the edit removes stops notifying.
    const properties = { ...keptProperties(original), mentions: composed.properties.mentions ?? '[]' };

    await chatApi<Record<string, unknown>>(messagePath, {
      method: 'PUT',
      body: {
        content: quoteCard === null ? composed.content : `${quoteCard}\n${composed.content}`,
        messagetype: 'RichText/Html',
        contenttype: 'text',
        properties,
      },
    });
    return { success: true, mentions: composed.mentions };
  },
});
