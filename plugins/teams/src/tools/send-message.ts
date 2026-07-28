import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { markdownToTeamsHtml } from '../markdown-html.js';
import { chatApi } from '../teams-api.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message to a Teams chat conversation. Use the conversation ID from list_conversations or create_chat. ' +
    'The text is written in Markdown and rendered natively in Teams: **bold**, *italic*, ~~strikethrough~~, `code`, ' +
    '```fenced code blocks```, [links](https://example.com), bulleted lists ("- item"), numbered lists ("1. item"), ' +
    'headings ("# Title"), block quotes ("> quote"), horizontal rules ("---"), and GFM pipe tables. For formatting ' +
    'Markdown cannot express, inline HTML is allowed: underline (<u>text</u>), text colour ' +
    '(<span style="color:NAME">text</span>), highlight (<span style="background-color:NAME">text</span>), and font ' +
    'size (<span style="font-size:large|medium|small">text</span>). Colour NAME is one of the Teams swatches: red, ' +
    'orange, gold, lime, green, teal, blue, magenta. Blank lines separate paragraphs; single newlines become line breaks.',
  summary: 'Send a message to a chat',
  icon: 'send',
  group: 'Messages',
  input: z.object({
    conversation_id: z.string().min(1).describe('Conversation/thread ID to send the message to'),
    text: z.string().min(1).describe('Message text in Markdown'),
  }),
  output: z.object({
    message_id: z.string().describe('Server-assigned message ID (arrival timestamp)'),
    client_message_id: z.string().describe('Client-assigned message ID'),
  }),
  handle: async params => {
    const clientMsgId = Date.now().toString();
    const data = await chatApi<{ OriginalArrivalTime?: number }>(
      `/v1/users/ME/conversations/${encodeURIComponent(params.conversation_id)}/messages`,
      {
        method: 'POST',
        body: {
          content: markdownToTeamsHtml(params.text),
          messagetype: 'RichText/Html',
          contenttype: 'text',
          clientmessageid: clientMsgId,
        },
      },
    );

    return {
      message_id: String(data.OriginalArrivalTime ?? ''),
      client_message_id: clientMsgId,
    };
  },
});
