import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as teamsApi from '../teams-api.js';
import { readMessages } from './read-messages.js';

vi.mock('../teams-api.js', () => ({
  chatApi: vi.fn(),
  getDirectoryUsers: vi.fn(),
  getGraphUserId: vi.fn(),
  hasGraphToken: vi.fn(),
  threadApi: vi.fn(),
}));

const chatApi = vi.mocked(teamsApi.chatApi);
const getDirectoryUsers = vi.mocked(teamsApi.getDirectoryUsers);
const hasGraphToken = vi.mocked(teamsApi.hasGraphToken);
const context: ToolHandlerContext = { reportProgress: vi.fn() };
const CHAT = '19:abc@thread.v2';

const message = (id: string, composetime: string, fields: Record<string, unknown> = {}) => ({
  id,
  composetime,
  messagetype: 'RichText/Html',
  content: `<p>${id}</p>`,
  ...fields,
});

beforeEach(() => {
  chatApi.mockReset();
  getDirectoryUsers.mockReset();
  hasGraphToken.mockReset();
  hasGraphToken.mockReturnValue(false);
});

describe('read_messages', () => {
  test('orders by when messages were written, not by the service order that follows edits', async () => {
    chatApi.mockResolvedValue({
      messages: [
        message('edited', '2026-10-30T16:45:27.000Z', { properties: { edittime: 1793378920468 } }),
        message('later', '2026-10-30T16:48:27.000Z'),
      ],
    });
    const { messages } = await readMessages.handle({ conversation_id: CHAT }, context);
    expect(messages.map(m => m.id)).toEqual(['later', 'edited']);
    expect(messages[1]?.edited_at).toBe('2026-10-30T11:48:40.468-05:00');
    expect(messages[1]?.compose_time).toBe('2026-10-30T11:45:27-05:00');
    expect(messages[0]?.edited_at).toBeNull();
  });

  test('marks a deleted message instead of showing a blank one', async () => {
    chatApi.mockResolvedValue({
      messages: [
        message('gone', '2026-10-30T16:45:27.000Z', { content: undefined, properties: { deletetime: 1793367487562 } }),
        message('kept', '2026-10-30T16:44:27.000Z', { properties: { deletetime: 0 } }),
      ],
    });
    const { messages } = await readMessages.handle({ conversation_id: CHAT }, context);
    expect(messages.map(m => [m.id, m.deleted, m.content])).toEqual([
      ['gone', true, ''],
      ['kept', false, '<p>kept</p>'],
    ]);
  });

  test('returns a token for older messages and passes one back', async () => {
    chatApi.mockResolvedValue({
      messages: [message('a', '2026-10-30T16:45:27.000Z')],
      _metadata: { backwardLink: 'https://teams.microsoft.com/x/messages?startTime=0&syncState=next&pageSize=5' },
    });

    const { next_page_token } = await readMessages.handle(
      { conversation_id: CHAT, page_size: 5, next_page_token: 'syncState=this&startTime=0' },
      context,
    );

    expect(next_page_token).toBe('syncState=next&startTime=0');
    expect(chatApi.mock.calls[0]?.[1]?.query).toEqual({ syncState: 'this', startTime: '0', pageSize: 5 });
  });

  describe('channel messages', () => {
    const PAT = 'bbbbbbbb-0000-0000-0000-000000000002';
    const SAM = 'cccccccc-0000-0000-0000-000000000003';
    const CHANNEL = '19:abc@thread.tacv2';
    const contact = (id: string) => `https://teams.cloud.microsoft/api/chatsvc/amer/v1/users/ME/contacts/8:orgid:${id}`;

    test('looks up the sender names the service leaves blank', async () => {
      hasGraphToken.mockReturnValue(true);
      getDirectoryUsers.mockResolvedValue([{ id: PAT, displayName: 'Pat Doe', mail: null, userPrincipalName: '' }]);
      chatApi.mockResolvedValue({
        messages: [
          message('blank', '2026-10-30T16:45:27.000Z', { from: contact(PAT), imdisplayname: '' }),
          message('unknown', '2026-10-30T16:44:27.000Z', { from: contact(SAM) }),
          message('named', '2026-10-30T16:43:27.000Z', { from: contact(SAM), imdisplayname: 'Sam Roe' }),
        ],
      });
      const { messages } = await readMessages.handle({ conversation_id: CHANNEL }, context);
      expect(messages.map(m => m.display_name)).toEqual(['Pat Doe', '', 'Sam Roe']);
      expect(getDirectoryUsers).toHaveBeenCalledWith([PAT, SAM]);
    });

    test('still reads the channel when names cannot be looked up', async () => {
      chatApi.mockResolvedValue({ messages: [message('blank', '2026-10-30T16:45:27.000Z', { from: contact(PAT) })] });
      const { messages } = await readMessages.handle({ conversation_id: CHANNEL }, context);
      expect(messages[0]?.display_name).toBe('');
      expect(messages[0]?.from).toBe(`8:orgid:${PAT}`);
    });

    test('marks a reply with the post it answers, and leaves a post unmarked', async () => {
      chatApi.mockResolvedValue({
        messages: [
          message('reply', '2026-10-30T16:45:27.000Z', { rootMessageId: 'post' }),
          message('post', '2026-10-30T16:44:27.000Z', { rootMessageId: 'post' }),
          message('chat', '2026-10-30T16:43:27.000Z'),
        ],
      });
      const { messages } = await readMessages.handle({ conversation_id: CHANNEL }, context);
      expect(messages.map(m => m.reply_to_post_id)).toEqual(['post', null, null]);
    });

    test('shows which meeting a post announces', async () => {
      const meeting = (type: string, info: Record<string, unknown>) =>
        JSON.stringify({
          '@type': `http://schema.skype.com/${type}`,
          meetingtitle: 'Weekly review',
          meetingJoinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
          scheduledmeetinginfo: {
            startTime: '2026-11-02T14:00:00+00:00',
            endTime: '2026-11-02T15:00:00+00:00',
            ...info,
          },
        });
      chatApi.mockResolvedValue({
        messages: [
          message('created', '2026-10-30T16:45:27.000Z', {
            properties: { meeting: meeting('ScheduledMeetingCreated', { location: 'Room 4' }) },
          }),
          message('cancelled', '2026-10-30T16:44:27.000Z', {
            properties: { meeting: meeting('ScheduledMeetingCancelled', {}) },
          }),
          message('broken', '2026-10-30T16:43:27.000Z', { properties: { meeting: 'not json' } }),
        ],
      });
      const { messages } = await readMessages.handle({ conversation_id: CHANNEL }, context);
      expect(messages[0]?.meeting).toEqual({
        title: 'Weekly review',
        start: '2026-11-02T08:00:00-06:00',
        end: '2026-11-02T09:00:00-06:00',
        location: 'Room 4',
        is_cancelled: false,
        join_url: 'https://teams.microsoft.com/l/meetup-join/x',
      });
      expect(messages[1]?.meeting?.is_cancelled).toBe(true);
      expect(messages[2]?.meeting).toBeNull();
    });
  });

  test('offers no token after a page with nothing in it', async () => {
    chatApi.mockResolvedValue({
      messages: [],
      _metadata: { backwardLink: 'https://teams.microsoft.com/x?syncState=s' },
    });
    const { next_page_token } = await readMessages.handle({ conversation_id: CHAT }, context);
    expect(next_page_token).toBeNull();
  });
});
