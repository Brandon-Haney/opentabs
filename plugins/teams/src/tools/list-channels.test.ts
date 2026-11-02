import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as teamsApi from '../teams-api.js';
import { listChannels } from './list-channels.js';

vi.mock('../teams-api.js', () => ({ chatAggregatorApi: vi.fn() }));

const chatAggregatorApi = vi.mocked(teamsApi.chatAggregatorApi);
const context: ToolHandlerContext = { reportProgress: vi.fn() };

beforeEach(() => {
  chatAggregatorApi.mockReset();
});

describe('list_channels', () => {
  test('returns each team with its channels', async () => {
    chatAggregatorApi.mockResolvedValue({
      teams: [
        {
          id: '19:team@thread.tacv2',
          displayName: 'Project Renaissance',
          description: 'Program team',
          channels: [
            { id: '19:team@thread.tacv2', displayName: 'General', isGeneral: true, isFavorite: true, channelType: 0 },
            { id: '19:pmo@thread.tacv2', displayName: 'PMO', channelType: 1, isArchived: true },
            { id: '19:shared@thread.tacv2', displayName: 'Vendors', channelType: 0, isShared: true },
          ],
        },
      ],
    });

    const { teams } = await listChannels.handle({}, context);

    expect(teams).toEqual([
      {
        id: '19:team@thread.tacv2',
        name: 'Project Renaissance',
        description: 'Program team',
        is_archived: false,
        channels: [
          {
            id: '19:team@thread.tacv2',
            name: 'General',
            is_general: true,
            is_favorite: true,
            is_archived: false,
            membership_type: 'standard',
          },
          {
            id: '19:pmo@thread.tacv2',
            name: 'PMO',
            is_general: false,
            is_favorite: false,
            is_archived: true,
            membership_type: 'private',
          },
          {
            id: '19:shared@thread.tacv2',
            name: 'Vendors',
            is_general: false,
            is_favorite: false,
            is_archived: false,
            membership_type: 'shared',
          },
        ],
      },
    ]);
  });

  test('leaves out deleted teams and channels', async () => {
    chatAggregatorApi.mockResolvedValue({
      teams: [
        { id: 'gone', isDeleted: true, channels: [{ id: 'a' }] },
        {
          id: 'kept',
          channels: [{ id: 'b', isDeleted: true }, { id: 'c' }],
        },
      ],
    });

    const { teams } = await listChannels.handle({}, context);

    expect(teams.map(team => team.id)).toEqual(['kept']);
    expect(teams[0]?.channels.map(channel => channel.id)).toEqual(['c']);
  });

  test('returns no teams when the service lists none', async () => {
    chatAggregatorApi.mockResolvedValue({});
    await expect(listChannels.handle({}, context)).resolves.toEqual({ teams: [] });
  });
});
