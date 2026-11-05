import { ToolError } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DirectoryUser } from '../teams-api.js';
import * as teamsApi from '../teams-api.js';
import { addMember } from './add-member.js';
import { createChat } from './create-chat.js';
import { findPeople } from './find-people.js';
import { removeMember } from './remove-member.js';

vi.mock('../teams-api.js', () => ({
  createThread: vi.fn(),
  findDirectoryUsersByEmail: vi.fn(),
  getDirectoryUsers: vi.fn(),
  getGraphUserId: vi.fn(),
  getSkypeIdentity: vi.fn(),
  hasGraphToken: vi.fn(),
  searchDirectory: vi.fn(),
  threadApi: vi.fn(),
  waitForGraphToken: vi.fn(),
}));

const api = vi.mocked(teamsApi);

const ME = 'dd24679a-0000-4000-8000-000000000001';
const GARY = '70d13946-0000-4000-8000-000000000002';
const CHRIS = '79d87ef1-0000-4000-8000-000000000003';

const user = (id: string, displayName: string, mail: string, upn = `${id.slice(0, 6)}@contoso.net`): DirectoryUser => ({
  id,
  displayName,
  mail,
  userPrincipalName: upn,
});
const DIRECTORY = [
  user(ME, 'Brandon Haney', 'brandon@contoso.com'),
  user(GARY, 'Gary Winko', 'gary_winko@contoso.com'),
  user(CHRIS, 'Chris Sheehan', 'chris@contoso.com'),
];

/** The rejection of `promise` as a ToolError. */
const toolError = async (promise: Promise<unknown>): Promise<ToolError> => {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ToolError);
  return outcome as ToolError;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.hasGraphToken.mockReturnValue(true);
  api.getGraphUserId.mockReturnValue(ME);
  api.getSkypeIdentity.mockResolvedValue({ skypeid: `orgid:${ME}`, signinname: 'brandon@contoso.com' });
  api.findDirectoryUsersByEmail.mockImplementation(async emails =>
    DIRECTORY.filter(u => emails.some(e => e.toLowerCase() === u.mail?.toLowerCase())),
  );
  api.getDirectoryUsers.mockImplementation(async ids => DIRECTORY.filter(u => ids.includes(u.id)));
  api.createThread.mockResolvedValue('19:new@thread.v2');
  api.threadApi.mockResolvedValue({});
});

describe('create_chat', () => {
  test('starts a group chat by email with every member an Admin, the caller first', async () => {
    const result = await createChat.handle(
      { members: ['gary_winko@contoso.com', 'Chris@Contoso.com'], topic: 'Backorders' },
      undefined,
    );

    expect(api.createThread).toHaveBeenCalledWith(
      [
        { id: `8:orgid:${ME}`, role: 'Admin' },
        { id: `8:orgid:${GARY}`, role: 'Admin' },
        { id: `8:orgid:${CHRIS}`, role: 'Admin' },
      ],
      { threadType: 'chat', chatFilesIndexId: 2, topic: 'Backorders' },
    );
    expect(result).toEqual({
      conversation_id: '19:new@thread.v2',
      chat_type: 'group',
      members: [
        { mri: `8:orgid:${GARY}`, name: 'Gary Winko', email: 'gary_winko@contoso.com' },
        { mri: `8:orgid:${CHRIS}`, name: 'Chris Sheehan', email: 'chris@contoso.com' },
      ],
    });
  });

  test('makes a fixed one-on-one chat for one other person, leaving the caller out of the named list', async () => {
    const result = await createChat.handle({ members: [`8:orgid:${GARY}`, `8:orgid:${ME}`] }, undefined);

    expect(api.createThread).toHaveBeenCalledWith(
      [
        { id: `8:orgid:${ME}`, role: 'Admin' },
        { id: `8:orgid:${GARY}`, role: 'Admin' },
      ],
      { threadType: 'chat', chatFilesIndexId: 2, fixedRoster: true, uniquerosterthread: true },
    );
    expect(result.chat_type).toBe('one_on_one');
    expect(result.members).toEqual([{ mri: `8:orgid:${GARY}`, name: 'Gary Winko', email: null }]);
  });

  test('refuses a topic on a one-on-one chat before creating anything', async () => {
    const error = await toolError(createChat.handle({ members: ['gary_winko@contoso.com'], topic: 'x' }, undefined));

    expect(error.message).toContain('one-on-one');
    expect(api.createThread).not.toHaveBeenCalled();
  });

  test('fails on an address no one has, naming it, before creating anything', async () => {
    const error = await toolError(
      createChat.handle({ members: ['gary_winko@contoso.com', 'nobody@contoso.com'] }, undefined),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('nobody@contoso.com');
    expect(api.createThread).not.toHaveBeenCalled();
  });

  test('refuses a bare name and points to find_people', async () => {
    const error = await toolError(createChat.handle({ members: ['Gary Winko'] }, undefined));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('find_people');
  });

  test('refuses a chat with no one but the caller', async () => {
    const error = await toolError(createChat.handle({ members: ['brandon@contoso.com'] }, undefined));

    expect(error.message).toContain('other than yourself');
  });

  test('takes a bare directory object id as that person', async () => {
    await createChat.handle({ members: [GARY, CHRIS] }, undefined);

    expect(api.createThread.mock.calls[0]?.[0]).toContainEqual({ id: `8:orgid:${GARY}`, role: 'Admin' });
  });
});

describe('add_member', () => {
  test('adds people as Admins without history by default, as the Add people dialog does', async () => {
    const result = await addMember.handle(
      { conversation_id: '19:chat@thread.v2', people: ['gary_winko@contoso.com'], include_history: 'none' },
      undefined,
    );

    expect(api.threadApi).toHaveBeenCalledWith('19:chat@thread.v2', '/members', {
      method: 'PUT',
      body: { members: [{ id: `8:orgid:${GARY}`, role: 'Admin', shareHistoryTime: -1 }] },
      retryNonIdempotent: true,
    });
    expect(result.added).toEqual([{ mri: `8:orgid:${GARY}`, name: 'Gary Winko', email: 'gary_winko@contoso.com' }]);
    expect(result.not_added).toEqual([]);
  });

  test('shares all history as time zero, and some days as the time they start', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') });
    try {
      await addMember.handle(
        { conversation_id: '19:chat@thread.v2', people: [GARY], include_history: 'all' },
        undefined,
      );
      await addMember.handle(
        { conversation_id: '19:chat@thread.v2', people: [GARY], include_history: 'days', history_days: 7 },
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }

    const sent = api.threadApi.mock.calls.map(([, , options]) => options?.body?.members);
    expect(sent[0]).toEqual([{ id: `8:orgid:${GARY}`, role: 'Admin', shareHistoryTime: 0 }]);
    expect(sent[1]).toEqual([
      { id: `8:orgid:${GARY}`, role: 'Admin', shareHistoryTime: Date.parse('2026-10-29T12:00:00Z') },
    ]);
  });

  test('reports people Teams declined to add', async () => {
    api.threadApi.mockResolvedValue({
      multipleStatus: [
        { id: `8:orgid:${GARY}`, statusCode: 200 },
        { id: `8:orgid:${CHRIS}`, statusCode: 403, statusSubCode: 7 },
      ],
    });

    const result = await addMember.handle(
      { conversation_id: '19:chat@thread.v2', people: [GARY, CHRIS], include_history: 'none' },
      undefined,
    );

    expect(result.added.map(p => p.mri)).toEqual([`8:orgid:${GARY}`]);
    expect(result.not_added).toEqual([{ mri: `8:orgid:${CHRIS}`, status_code: 403 }]);
  });

  test('refuses a one-on-one chat and a channel', async () => {
    const oneOnOne = await toolError(
      addMember.handle(
        { conversation_id: `19:${ME}_${GARY}@unq.gbl.spaces`, people: [CHRIS], include_history: 'none' },
        undefined,
      ),
    );
    const channel = await toolError(
      addMember.handle({ conversation_id: '19:abc@thread.tacv2', people: [CHRIS], include_history: 'none' }, undefined),
    );

    expect(oneOnOne.message).toContain('create_chat');
    expect(channel.message).toContain('team');
    expect(api.threadApi).not.toHaveBeenCalled();
  });

  test('requires history_days when sharing some days', () => {
    const parsed = addMember.input.safeParse({
      conversation_id: '19:chat@thread.v2',
      people: [GARY],
      include_history: 'days',
    });

    expect(parsed.success).toBe(false);
  });
});

describe('remove_member', () => {
  test('removes a person named by email', async () => {
    await removeMember.handle({ conversation_id: '19:chat@thread.v2', user: 'chris@contoso.com' }, undefined);

    expect(api.threadApi).toHaveBeenCalledWith(
      '19:chat@thread.v2',
      `/members/${encodeURIComponent(`8:orgid:${CHRIS}`)}`,
      { method: 'DELETE' },
    );
  });
});

describe('find_people', () => {
  test('looks an email address up exactly', async () => {
    const result = await findPeople.handle({ query: 'gary_winko@contoso.com' }, undefined);

    expect(api.searchDirectory).not.toHaveBeenCalled();
    expect(result.people).toEqual([
      {
        name: 'Gary Winko',
        email: 'gary_winko@contoso.com',
        sign_in_name: '70d139@contoso.net',
        mri: `8:orgid:${GARY}`,
        job_title: null,
        department: null,
      },
    ]);
  });

  test('searches a name, ten people by default', async () => {
    api.searchDirectory.mockResolvedValue([
      { ...user(GARY, 'Gary Winko', 'gary_winko@contoso.com'), jobTitle: 'Buyer', department: 'Supply' },
    ]);

    const result = await findPeople.handle({ query: 'Gary Winko' }, undefined);

    expect(api.searchDirectory).toHaveBeenCalledWith('Gary Winko', 10);
    expect(result.people[0]).toMatchObject({ mri: `8:orgid:${GARY}`, job_title: 'Buyer', department: 'Supply' });
  });

  test('lists accounts with a mailbox before a namesake without one', async () => {
    const adminAccount = {
      id: 'admin-oid',
      displayName: 'Gary Winko',
      mail: null,
      userPrincipalName: 'x1@contoso.net',
    };
    api.searchDirectory.mockResolvedValue([adminAccount, user(GARY, 'Gary Winko', 'gary_winko@contoso.com')]);

    const result = await findPeople.handle({ query: 'Gary Winko' }, undefined);

    expect(result.people.map(p => [p.email, p.sign_in_name])).toEqual([
      ['gary_winko@contoso.com', '70d139@contoso.net'],
      [null, 'x1@contoso.net'],
    ]);
  });

  test('waits for the Graph token Teams renews after a reload', async () => {
    api.hasGraphToken.mockReturnValue(false);
    api.waitForGraphToken.mockResolvedValue();
    api.searchDirectory.mockResolvedValue([]);

    await findPeople.handle({ query: 'Gary' }, undefined);

    expect(api.waitForGraphToken).toHaveBeenCalled();
  });
});
