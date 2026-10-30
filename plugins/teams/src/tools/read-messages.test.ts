import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as teamsApi from '../teams-api.js';
import { readMessages } from './read-messages.js';

vi.mock('../teams-api.js', () => ({ chatApi: vi.fn() }));

const chatApi = vi.mocked(teamsApi.chatApi);
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
    expect(messages[1]?.edited_at).toBe(new Date(1793378920468).toISOString());
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

  test('offers no token after a page with nothing in it', async () => {
    chatApi.mockResolvedValue({
      messages: [],
      _metadata: { backwardLink: 'https://teams.microsoft.com/x?syncState=s' },
    });
    const { next_page_token } = await readMessages.handle({ conversation_id: CHAT }, context);
    expect(next_page_token).toBeNull();
  });
});
