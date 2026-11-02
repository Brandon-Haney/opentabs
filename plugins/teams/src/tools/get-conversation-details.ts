import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { directoryIdOfMri, lookUpDisplayNames, memberLabel } from '../participants.js';
import { threadApi } from '../teams-api.js';
import { threadName } from './schemas.js';

const memberSchema = z.object({
  id: z.string().describe('Member MRI (e.g., "8:live:username")'),
  role: z.string().describe('Member role (e.g., "Admin", "User")'),
  name: z.string().describe('Display name, or the MRI when the directory has no name for this member'),
});

export const getConversationDetails = defineTool({
  name: 'get_conversation_details',
  displayName: 'Get Conversation Details',
  description:
    'Get detailed information about a chat or channel including its members with their names, topic, creator, and creation time. A channel returns only you in `members`; `member_count` holds the full number.',
  summary: 'Get chat details and members',
  icon: 'info',
  group: 'Chats',
  input: z.object({
    conversation_id: z.string().min(1).describe('Conversation/thread ID'),
  }),
  output: z.object({
    id: z.string().describe('Conversation/thread ID'),
    topic: z.string().describe("Chat or channel name; a team's General channel carries the team's name"),
    creator: z.string().describe('Creator MRI'),
    created_at: z.string().describe('Creation timestamp'),
    thread_type: z
      .string()
      .describe('Thread type ("chat", "meeting", or for a channel "space" when General and "topic" otherwise)'),
    member_count: z.number().nullable().describe('Total members, or null when Teams does not report it'),
    members: z.array(memberSchema).describe('Chat members; on a channel, only you'),
  }),
  handle: async params => {
    const data = await threadApi<{
      id?: string;
      properties?: Record<string, unknown>;
      members?: Array<{ id?: string; role?: string }>;
      rosterSummary?: { memberCount?: number };
    }>(params.conversation_id, '?view=msnp24Equivalent');

    const members = data.members ?? [];
    const names = await lookUpDisplayNames(members.flatMap(m => directoryIdOfMri(m.id ?? '') ?? []));

    return {
      id: data.id ?? params.conversation_id,
      topic: threadName(data.properties),
      creator: String(data.properties?.creator ?? ''),
      created_at: String(data.properties?.createdat ?? ''),
      thread_type: String(data.properties?.threadType ?? ''),
      member_count: data.rosterSummary?.memberCount ?? null,
      members: members.map(m => ({
        id: m.id ?? '',
        role: m.role ?? '',
        name: memberLabel(m.id ?? '', names ?? new Map()),
      })),
    };
  },
});
