import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DirectoryUser, UploadedDriveItem } from './teams-api.js';

const api = vi.hoisted(() => ({
  getDirectoryUsers: vi.fn<(ids: string[]) => Promise<DirectoryUser[]>>(),
  getDriveWebUrl: vi.fn<() => Promise<string>>(),
  getGraphUserId: vi.fn<() => string>(),
  shareFileWith: vi.fn<(itemId: string, emails: string[], role: 'read' | 'write') => Promise<void>>(),
  threadApi: vi.fn<(threadId: string, subpath: string) => Promise<unknown>>(),
  uploadChatFile: vi.fn<(name: string, bytes: Uint8Array, contentType: string) => Promise<UploadedDriveItem>>(),
}));
vi.mock('./teams-api.js', () => ({ ...api, CHAT_FILES_FOLDER: 'Microsoft Teams Chat Files' }));

const { composeMessage } = await import('./compose-message.js');

const user = (id: string, displayName: string): DirectoryUser => ({
  id,
  displayName,
  mail: `${id}@contoso.com`,
  userPrincipalName: `${id}@contoso.com`,
});
const ME = user('me', 'Brandon Haney');
const SANDIP = user('sandip', 'Sandip Kumar');
const DRIVE = 'https://contoso-my.sharepoint.com/personal/me/Documents';

/** A tool context delivering one local file per path. */
const contextWithFiles = (): ToolHandlerContext =>
  ({
    reportProgress: () => {},
    localFile: (path: string) => ({
      name: path.split('\\').pop() ?? path,
      size: 3,
      contentType: 'text/csv',
      contentBase64: 'YSxi',
    }),
  }) as unknown as ToolHandlerContext;

const chatThread = (threadType = 'chat') => ({
  properties: { threadType },
  members: [{ id: '8:orgid:me' }, { id: '8:orgid:sandip' }, { id: '28:bot' }],
});

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getGraphUserId.mockReturnValue('me');
  api.getDirectoryUsers.mockImplementation(async ids =>
    [ME, SANDIP].filter(u => ids.includes(u.id) || ids.includes(u.userPrincipalName)),
  );
  api.getDriveWebUrl.mockResolvedValue(DRIVE);
  api.uploadChatFile.mockImplementation(async name => ({
    id: `item-${name}`,
    name,
    sharepointIds: { listItemUniqueId: `uid-${name}`, siteUrl: 'https://contoso-my.sharepoint.com/personal/me' },
  }));
});

describe('composeMessage', () => {
  test('sends plain Markdown without looking anyone up', async () => {
    const composed = await composeMessage(
      { conversationId: '19:chat', text: 'hello', files: [], fileAccess: 'view' },
      undefined,
    );

    expect(composed).toEqual({ content: '<p>hello</p>', properties: {}, mentions: [], files: [] });
    expect(api.threadApi).not.toHaveBeenCalled();
  });

  test('resolves a mention against the chat members, ignoring non-person members', async () => {
    api.threadApi.mockResolvedValue(chatThread());

    const composed = await composeMessage(
      { conversationId: '19:chat', text: 'Thanks @[Sandip]', files: [], fileAccess: 'view' },
      undefined,
    );

    expect(api.getDirectoryUsers).toHaveBeenCalledWith(['me', 'sandip']);
    expect(composed.mentions).toEqual([{ text: 'Sandip', display_name: 'Sandip Kumar', email: 'sandip@contoso.com' }]);
    expect(JSON.parse(composed.properties.mentions as string)[0].mri).toBe('8:orgid:sandip');
  });

  test('fails an unmatched mention before uploading any file', async () => {
    api.threadApi.mockResolvedValue(chatThread());

    await expect(
      composeMessage(
        { conversationId: '19:chat', text: 'cc @[Priya]', files: ['C:\\a.csv'], fileAccess: 'view' },
        contextWithFiles(),
      ),
    ).rejects.toThrow(/matches no one/);
    expect(api.uploadChatFile).not.toHaveBeenCalled();
  });

  test('uploads a file and shares it with every member but the sender', async () => {
    api.threadApi.mockResolvedValue(chatThread());

    const composed = await composeMessage(
      { conversationId: '19:chat', text: '', files: ['C:\\data\\a.csv'], fileAccess: 'edit' },
      contextWithFiles(),
    );

    expect(api.uploadChatFile).toHaveBeenCalledWith('a.csv', new Uint8Array([97, 44, 98]), 'text/csv');
    expect(api.shareFileWith).toHaveBeenCalledWith('item-a.csv', ['sandip@contoso.com'], 'write');
    expect(composed.content).toBe('');
    expect(JSON.parse(composed.properties.files as string)[0]).toMatchObject({ id: 'uid-a.csv', title: 'a.csv' });
    expect(composed.files).toEqual([
      { name: 'a.csv', url: `${DRIVE}/Microsoft%20Teams%20Chat%20Files/a.csv`, shared_with: 1 },
    ]);
  });

  test('shares nothing in the self chat, which has no other members', async () => {
    const composed = await composeMessage(
      { conversationId: '48:notes', text: 'note @[Brandon]', files: ['C:\\a.csv'], fileAccess: 'view' },
      contextWithFiles(),
    );

    expect(api.threadApi).not.toHaveBeenCalled();
    expect(api.shareFileWith).not.toHaveBeenCalled();
    expect(composed.mentions[0]?.display_name).toBe('Brandon Haney');
  });

  test('refuses files in a channel', async () => {
    api.threadApi.mockResolvedValue(chatThread('space'));

    await expect(
      composeMessage(
        { conversationId: '19:channel@thread.tacv2', text: 'x', files: ['C:\\a.csv'], fileAccess: 'view' },
        contextWithFiles(),
      ),
    ).rejects.toThrow(/chats, not channels/);
    expect(api.uploadChatFile).not.toHaveBeenCalled();
  });

  test('looks up a person mentioned by email who is not in the conversation', async () => {
    api.threadApi.mockResolvedValue({ properties: { threadType: 'chat' }, members: [{ id: '8:orgid:me' }] });

    const composed = await composeMessage(
      { conversationId: '19:chat', text: 'fyi @[sandip@contoso.com]', files: [], fileAccess: 'view' },
      undefined,
    );

    expect(api.getDirectoryUsers).toHaveBeenLastCalledWith(['sandip@contoso.com']);
    expect(composed.content).toContain('itemid="0">Sandip Kumar</span>');
  });

  test('shows the first name for a person an @[Text](email) mention names by email', async () => {
    api.threadApi.mockResolvedValue({ properties: { threadType: 'chat' }, members: [{ id: '8:orgid:me' }] });

    const composed = await composeMessage(
      { conversationId: '19:chat', text: 'fyi @[Sandip](sandip@contoso.com)', files: [], fileAccess: 'view' },
      undefined,
    );

    expect(api.getDirectoryUsers).toHaveBeenLastCalledWith(['sandip@contoso.com']);
    expect(composed.content).toContain('itemid="0">Sandip</span>');
    expect(composed.mentions).toEqual([{ text: 'Sandip', display_name: 'Sandip Kumar', email: 'sandip@contoso.com' }]);
  });
});
