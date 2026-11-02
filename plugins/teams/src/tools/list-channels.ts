import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { chatAggregatorApi } from '../teams-api.js';

const channelSchema = z.object({
  id: z.string().describe('Channel ID, usable with read_messages and get_conversation_details'),
  name: z.string().describe('Channel name'),
  is_general: z.boolean().describe("Whether this is the team's General channel"),
  is_favorite: z.boolean().describe('Whether Teams marks the channel to show in your teams list'),
  is_archived: z.boolean().describe('Whether the channel is archived'),
  membership_type: z
    .enum(['standard', 'private', 'shared'])
    .describe('Who the channel is open to: the whole team, chosen members, or people outside the team too'),
});

const teamSchema = z.object({
  id: z.string().describe("Team ID, the same as its General channel's ID"),
  name: z.string().describe('Team name'),
  description: z.string().describe('Team description (empty if none)'),
  is_archived: z.boolean().describe('Whether the team is archived'),
  channels: z.array(channelSchema).describe('Channels in this team that you can see'),
});

interface RawChannel {
  id?: string;
  displayName?: string;
  isGeneral?: boolean;
  isFavorite?: boolean;
  isArchived?: boolean;
  isDeleted?: boolean;
  isShared?: boolean;
  channelType?: number;
}

interface RawTeam {
  id?: string;
  displayName?: string;
  description?: string;
  isArchived?: boolean;
  isDeleted?: boolean;
  channels?: RawChannel[];
}

/** `channelType` is 0 for a standard channel and 1 for a private one; a shared channel carries `isShared`. */
const membershipType = (c: RawChannel): z.infer<typeof channelSchema>['membership_type'] => {
  if (c.isShared) return 'shared';
  return c.channelType === 1 ? 'private' : 'standard';
};

const mapChannel = (c: RawChannel): z.infer<typeof channelSchema> => ({
  id: c.id ?? '',
  name: c.displayName ?? '',
  is_general: c.isGeneral ?? false,
  is_favorite: c.isFavorite ?? false,
  is_archived: c.isArchived ?? false,
  membership_type: membershipType(c),
});

export const listChannels = defineTool({
  name: 'list_channels',
  displayName: 'List Channels',
  description:
    "List the teams you belong to and each team's channels, by name. Use a channel's id with read_messages to read it. Work or school Teams only.",
  summary: 'List your teams and channels',
  icon: 'users',
  group: 'Channels',
  input: z.object({}),
  output: z.object({
    teams: z.array(teamSchema).describe('Your teams and their channels'),
  }),
  handle: async () => {
    const data = await chatAggregatorApi<{ teams?: RawTeam[] }>('/api/v2/teams/users/me', { isPrefetch: false });
    return {
      teams: (data.teams ?? [])
        .filter(team => !team.isDeleted)
        .map(team => ({
          id: team.id ?? '',
          name: team.displayName ?? '',
          description: team.description ?? '',
          is_archived: team.isArchived ?? false,
          channels: (team.channels ?? []).filter(channel => !channel.isDeleted).map(mapChannel),
        })),
    };
  },
});
