import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachedFilePathSchema, composeMessage, fileAccessSchema } from '../compose-message.js';
import { MARKDOWN_FORMATTING_HELP } from '../markdown-html.js';
import { getReplyTarget, quotedMessagesProperty, replyQuoteHtml } from '../reply-quote.js';
import { chatApi } from '../teams-api.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message to a Teams chat conversation. Use the conversation ID from list_conversations or create_chat. ' +
    MARKDOWN_FORMATTING_HELP +
    ' Write @[Name] to @mention someone so they are notified; pass `files` to attach files from this computer; ' +
    'pass `reply_to_message_id` to quote-reply to a message.',
  summary: 'Send a message to a chat',
  icon: 'send',
  group: 'Messages',
  input: z.object({
    conversation_id: z.string().min(1).describe('Conversation/thread ID to send the message to'),
    text: z
      .string()
      .optional()
      .describe(
        'Message text in Markdown. @[Name] mentions a person: their display name or enough of it to be unique in ' +
          'the conversation (@[Sandip]), or their email (@[name@example.com]); the message shows the text written. ' +
          'May be omitted when sending files.',
      ),
    files: z
      .array(attachedFilePathSchema)
      .max(10)
      .optional()
      .describe(
        'Files on this computer to attach (up to 10, 25 MB in total). Each is uploaded to your OneDrive and shared ' +
          'with the people in the chat, as Teams does. Chats only — a channel keeps its files in SharePoint.',
      ),
    file_access: fileAccessSchema.optional(),
    reply_to_message_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'ID of a message in this conversation to reply to (the `id` from read_messages). The message opens with a ' +
          'quote of it, linked to the original.',
      ),
  }),
  output: z.object({
    message_id: z.string().describe('Server-assigned message ID (arrival timestamp)'),
    client_message_id: z.string().describe('Client-assigned message ID'),
    mentions: z
      .array(
        z.object({
          text: z.string().describe('The @[...] text as written'),
          display_name: z.string().describe('Who it resolved to'),
          email: z.string().describe('Their email'),
        }),
      )
      .describe('Each mention in the message, in order'),
    files: z
      .array(
        z.object({
          name: z.string().describe('File name in OneDrive (numbered when the name was already taken)'),
          url: z.string().describe('The file’s OneDrive address'),
          shared_with: z.number().int().describe('How many other chat members were given access'),
        }),
      )
      .describe('Each attached file'),
  }),
  handle: async (params, context) => {
    const text = params.text ?? '';
    const files = params.files ?? [];
    if (text.trim().length === 0 && files.length === 0) {
      throw ToolError.validation('Pass `text`, `files`, or both.');
    }
    // The original is fetched first, so a bad id fails the send before any file is uploaded.
    const replyTarget =
      params.reply_to_message_id === undefined
        ? undefined
        : await getReplyTarget(params.conversation_id, params.reply_to_message_id);
    const composed = await composeMessage(
      { conversationId: params.conversation_id, text, files, fileAccess: params.file_access ?? 'view' },
      context,
    );

    const content = replyTarget === undefined ? composed.content : replyQuoteHtml(replyTarget) + composed.content;
    const properties =
      replyTarget === undefined
        ? composed.properties
        : { ...composed.properties, qtdMsgs: quotedMessagesProperty(replyTarget) };

    const clientMsgId = Date.now().toString();
    const data = await chatApi<{ OriginalArrivalTime?: number }>(
      `/v1/users/ME/conversations/${encodeURIComponent(params.conversation_id)}/messages`,
      {
        method: 'POST',
        body: {
          content,
          messagetype: 'RichText/Html',
          contenttype: 'text',
          clientmessageid: clientMsgId,
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
        },
      },
    );

    return {
      message_id: String(data.OriginalArrivalTime ?? ''),
      client_message_id: clientMsgId,
      mentions: composed.mentions,
      files: composed.files,
    };
  },
});
