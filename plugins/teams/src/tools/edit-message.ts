import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { markdownToTeamsHtml } from '../markdown-html.js';
import { chatApi } from '../teams-api.js';

export const editMessage = defineTool({
  name: 'edit_message',
  displayName: 'Edit Message',
  description:
    'Edit a message in a Teams chat conversation. Only messages sent by the current user can be edited. The text is ' +
    'written in Markdown and rendered natively in Teams: **bold**, *italic*, ~~strikethrough~~, `code`, ' +
    '```fenced code blocks```, [links](https://example.com), bulleted lists ("- item"), numbered lists ("1. item"), ' +
    'headings ("# Title"), block quotes ("> quote"), horizontal rules ("---"), and GFM pipe tables. For formatting ' +
    'Markdown cannot express, inline HTML is allowed: underline (<u>text</u>), text colour ' +
    '(<span style="color:NAME">text</span>), highlight (<span style="background-color:NAME">text</span>), and font ' +
    'size (<span style="font-size:large|medium|small">text</span>). Colour NAME is one of the Teams swatches: red, ' +
    'orange, gold, lime, green, teal, blue, magenta. Blank lines separate paragraphs; single newlines become line breaks.',
  summary: 'Edit a chat message',
  icon: 'pencil',
  group: 'Messages',
  input: z.object({
    conversation_id: z.string().min(1).describe('Conversation/thread ID'),
    message_id: z.string().min(1).describe('Message ID to edit'),
    text: z.string().min(1).describe('New message content in Markdown'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the edit was successful'),
  }),
  handle: async params => {
    await chatApi<Record<string, unknown>>(
      `/v1/users/ME/conversations/${encodeURIComponent(params.conversation_id)}/messages/${encodeURIComponent(params.message_id)}`,
      {
        method: 'PUT',
        body: {
          content: markdownToTeamsHtml(params.text),
          messagetype: 'RichText/Html',
          contenttype: 'text',
        },
      },
    );
    return { success: true };
  },
});
