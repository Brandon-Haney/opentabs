import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { oneOnOneDirectoryIds } from '../participants.js';
import { personReferenceSchema, resolvePeople } from '../people.js';
import { threadApi } from '../teams-api.js';

/** The most days of history the Teams client offers to share with people it adds. */
const MAX_HISTORY_DAYS = 999;

const DAY_MS = 86_400_000;

/** Channel conversations, whose members come from their team rather than the chat. */
const isChannelId = (conversationId: string): boolean => /@thread\.(tacv2|skype)$/i.test(conversationId);

/**
 * The member field the Teams client sends for the history it shares with
 * people it adds: -1 for none, 0 for all of it, otherwise the time (ms since
 * the epoch) from which they see messages.
 */
const shareHistoryTime = (history: 'none' | 'all' | 'days', days: number | undefined, now: number): number => {
  if (history === 'none') return -1;
  if (history === 'all') return 0;
  return now - (days ?? 0) * DAY_MS;
};

/** A member the service declined to add, as its multi-status response reports them. */
interface MemberStatus {
  id?: string;
  statusCode?: number;
  statusSubCode?: number;
}

const personSchema = z.object({
  mri: z.string().describe('Member MRI'),
  name: z.string().nullable().describe('Display name, or null when the directory could not be asked'),
  email: z.string().nullable().describe('Email address, when the person was named by one'),
});

export const addMember = defineTool({
  name: 'add_member',
  displayName: 'Add Member',
  description:
    'Add people to a group chat or meeting chat, named by email address or MRI (find_people looks up a name), as ' +
    'the Teams "Add people" dialog does. include_history picks what they see of the earlier conversation: "none" ' +
    '(the default), "all", or "days" with history_days. A one-on-one chat cannot take more people — start a group ' +
    'chat with everyone using create_chat. Channel members come from their team, so channels are refused.',
  summary: 'Add people to a group chat',
  icon: 'user-plus',
  group: 'Members',
  input: z
    .object({
      conversation_id: z.string().min(1).describe('Conversation ID of the group chat'),
      people: z.array(personReferenceSchema).min(1).describe('The people to add, by email address or MRI'),
      include_history: z
        .enum(['none', 'all', 'days'])
        .default('none')
        .describe('What the added people see of the earlier conversation (default "none")'),
      history_days: z
        .number()
        .int()
        .min(1)
        .max(MAX_HISTORY_DAYS)
        .optional()
        .describe(`Days of history to share when include_history is "days" (1–${MAX_HISTORY_DAYS})`),
    })
    .refine(input => input.include_history !== 'days' || input.history_days !== undefined, {
      message: 'history_days is required when include_history is "days"',
      path: ['history_days'],
    }),
  output: z.object({
    added: z.array(personSchema).describe('The people added'),
    not_added: z
      .array(z.object({ mri: z.string(), status_code: z.number().nullable() }))
      .describe('People Teams declined to add, such as by an organization policy'),
  }),
  handle: async (params, context) => {
    if (oneOnOneDirectoryIds(params.conversation_id) || /@unq\.gbl\.spaces$/i.test(params.conversation_id)) {
      throw ToolError.validation(
        'A one-on-one chat cannot take more people. Start a group chat with everyone using create_chat.',
      );
    }
    if (isChannelId(params.conversation_id)) {
      throw ToolError.validation('Channel members come from their team; add the person to the team in Teams.');
    }

    const people = await resolvePeople(params.people, context);
    const historyFrom = shareHistoryTime(params.include_history, params.history_days, Date.now());
    const result = await threadApi<{ multipleStatus?: MemberStatus[] }>(params.conversation_id, '/members', {
      method: 'PUT',
      body: { members: people.map(person => ({ id: person.mri, role: 'Admin', shareHistoryTime: historyFrom })) },
      // Adding someone who is already a member changes nothing, so a replay is harmless.
      retryNonIdempotent: true,
    });

    const declined = (result.multipleStatus ?? []).filter(
      status => typeof status.statusCode === 'number' && status.statusCode >= 400 && status.id,
    );
    const declinedIds = new Set(declined.map(status => status.id?.toLowerCase()));
    return {
      added: people.filter(person => !declinedIds.has(person.mri.toLowerCase())),
      not_added: declined.map(status => ({ mri: status.id ?? '', status_code: status.statusCode ?? null })),
    };
  },
});
