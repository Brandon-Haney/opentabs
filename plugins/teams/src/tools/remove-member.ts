import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { personReferenceSchema, resolvePeople } from '../people.js';
import { threadApi } from '../teams-api.js';

export const removeMember = defineTool({
  name: 'remove_member',
  displayName: 'Remove Member',
  description:
    'Remove a person from a Teams group chat, named by email address or MRI (find_people looks up a name). ' +
    'Requires the Admin role in the chat, which Teams gives every member of a group chat it starts.',
  summary: 'Remove a person from a group chat',
  icon: 'user-minus',
  group: 'Members',
  input: z.object({
    conversation_id: z.string().min(1).describe('Conversation ID of the group chat'),
    user: personReferenceSchema.describe('The person to remove, by email address or MRI'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the member was removed'),
  }),
  handle: async (params, context) => {
    const [person] = await resolvePeople([params.user], context);
    if (!person) return { success: false };
    await threadApi<Record<string, unknown>>(params.conversation_id, `/members/${encodeURIComponent(person.mri)}`, {
      method: 'DELETE',
    });
    return { success: true };
  },
});
