import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { personReferenceSchema, resolvePeople } from '../people.js';
import { createThread, getSkypeIdentity } from '../teams-api.js';

const chatMemberSchema = z.object({
  mri: z.string().describe('Member MRI'),
  name: z.string().nullable().describe('Display name, or null when the directory could not be asked'),
  email: z.string().nullable().describe('Email address, when the member was named by one'),
});

export const createChat = defineTool({
  name: 'create_chat',
  displayName: 'Create Chat',
  description:
    'Start a chat with one or more people, named by email address or MRI (find_people looks up a name). You are ' +
    'added yourself. One other person makes a one-on-one chat (Teams returns the existing one if you already have ' +
    'it); two or more make a group chat, which anyone in it can add people to and which takes an optional topic. ' +
    'Send the first message with send_message.',
  summary: 'Start a one-on-one or group chat',
  icon: 'plus-circle',
  group: 'Chats',
  input: z.object({
    members: z
      .array(personReferenceSchema)
      .min(1)
      .describe('The people to chat with, by email address or MRI (e.g. ["name@example.com", "8:orgid:<id>"])'),
    topic: z.string().trim().min(1).optional().describe('Name for a group chat'),
  }),
  output: z.object({
    conversation_id: z.string().describe('The chat’s conversation ID, for send_message'),
    chat_type: z.enum(['one_on_one', 'group']).describe('Whether the chat is one-on-one or a group chat'),
    members: z.array(chatMemberSchema).describe('The people in the chat besides you'),
  }),
  handle: async (params, context) => {
    const self = `8:${(await getSkypeIdentity()).skypeid}`;
    const others = (await resolvePeople(params.members, context)).filter(
      person => person.mri.toLowerCase() !== self.toLowerCase(),
    );
    if (others.length === 0) throw ToolError.validation('Name at least one person other than yourself.');

    const isOneOnOne = others.length === 1;
    if (isOneOnOne && params.topic) {
      throw ToolError.validation(
        'A chat with one other person is a one-on-one chat, which has no topic. Leave out topic, or add more people.',
      );
    }

    // The Teams client's own chat: every member an Admin, which is what lets
    // anyone in a group chat add people, and a one-on-one chat's roster fixed
    // and unique, so the service hands back the existing chat with that person.
    const properties: Record<string, unknown> = { threadType: 'chat', chatFilesIndexId: 2 };
    if (isOneOnOne) Object.assign(properties, { fixedRoster: true, uniquerosterthread: true });
    if (params.topic) properties.topic = params.topic;
    const members = [self, ...others.map(person => person.mri)].map(id => ({ id, role: 'Admin' }));

    const conversationId = await createThread(members, properties);
    return {
      conversation_id: conversationId,
      chat_type: isOneOnOne ? ('one_on_one' as const) : ('group' as const),
      members: others,
    };
  },
});
