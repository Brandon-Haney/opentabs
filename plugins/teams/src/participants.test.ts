import { beforeEach, describe, expect, test, vi } from 'vitest';
import { directoryIdOfMri, findChatParticipants, memberLabel, oneOnOneDirectoryIds } from './participants.js';
import * as teamsApi from './teams-api.js';

vi.mock('./teams-api.js', () => ({
  getDirectoryUsers: vi.fn(),
  getGraphUserId: vi.fn(),
  hasGraphToken: vi.fn(),
  threadApi: vi.fn(),
}));

const { getDirectoryUsers, getGraphUserId, hasGraphToken, threadApi } = vi.mocked(teamsApi);

const ME = 'aaaaaaaa-0000-0000-0000-000000000001';
const PAT = 'bbbbbbbb-0000-0000-0000-000000000002';
const SAM = 'cccccccc-0000-0000-0000-000000000003';
const ONE_ON_ONE = `19:${ME}_${PAT}@unq.gbl.spaces`;
const GROUP = '19:abc123@thread.v2';

const user = (id: string, displayName: string) => ({ id, displayName, mail: null, userPrincipalName: '' });

beforeEach(() => {
  vi.resetAllMocks();
  hasGraphToken.mockReturnValue(true);
  getGraphUserId.mockReturnValue(ME);
});

describe('identifying members', () => {
  test('reads the directory id of an organization user only', () => {
    expect(directoryIdOfMri(`8:orgid:${PAT}`)).toBe(PAT);
    expect(directoryIdOfMri('28:bot-id')).toBeNull();
    expect(directoryIdOfMri('8:live:someone')).toBeNull();
  });

  test('reads both ids of a one-on-one chat, and nothing from a group chat', () => {
    expect(oneOnOneDirectoryIds(ONE_ON_ONE)).toEqual([ME, PAT]);
    expect(oneOnOneDirectoryIds(GROUP)).toBeNull();
  });

  test('labels a member the directory does not know by their MRI', () => {
    const names = new Map([[PAT, 'Pat Doe']]);
    expect(memberLabel(`8:orgid:${PAT}`, names)).toBe('Pat Doe');
    expect(memberLabel(`8:orgid:${SAM}`, names)).toBe(`8:orgid:${SAM}`);
    expect(memberLabel('28:bot-id', names)).toBe('28:bot-id');
  });
});

describe('findChatParticipants', () => {
  test('names the other people in one-on-one and group chats, leaving out the signed-in user', async () => {
    threadApi.mockResolvedValue({ members: [{ id: `8:orgid:${ME}` }, { id: `8:orgid:${SAM}` }, { id: '28:bot-id' }] });
    getDirectoryUsers.mockResolvedValue([user(ME, 'Me'), user(PAT, 'Pat Doe'), user(SAM, 'Sam Roe')]);

    const participants = await findChatParticipants([ONE_ON_ONE, GROUP]);

    expect(participants.get(ONE_ON_ONE)).toEqual(['Pat Doe']);
    expect(participants.get(GROUP)).toEqual(['Sam Roe', '28:bot-id']);
    expect(threadApi).toHaveBeenCalledTimes(1);
  });

  test('looks nothing up without a Graph token', async () => {
    hasGraphToken.mockReturnValue(false);
    await expect(findChatParticipants([ONE_ON_ONE])).resolves.toEqual(new Map());
    expect(getDirectoryUsers).not.toHaveBeenCalled();
  });

  test('leaves out a group chat whose members could not be read, keeping the rest', async () => {
    threadApi.mockRejectedValue(new Error('forbidden'));
    getDirectoryUsers.mockResolvedValue([user(PAT, 'Pat Doe')]);

    const participants = await findChatParticipants([ONE_ON_ONE, GROUP]);

    expect(participants.get(ONE_ON_ONE)).toEqual(['Pat Doe']);
    expect(participants.has(GROUP)).toBe(false);
  });

  test('returns no names when the directory lookup fails', async () => {
    getDirectoryUsers.mockRejectedValue(new Error('throttled'));
    await expect(findChatParticipants([ONE_ON_ONE])).resolves.toEqual(new Map());
  });
});
