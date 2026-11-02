import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getReplyTarget, quotedMessagesProperty, replyQuoteHtml } from './reply-quote.js';
import { chatApi } from './teams-api.js';

vi.mock('./teams-api.js', () => ({ chatApi: vi.fn() }));

const ME = '8:orgid:dd24679a-bbcd-4624-88f0-cf4efd4fdedc';

describe('replyQuoteHtml', () => {
  test('builds the Reply quote card linked to the original message', () => {
    const html = replyQuoteHtml({
      id: '1790865035983',
      from: `https://amer.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${ME}`,
      imdisplayname: 'Brandon <Haney>',
      content: '<p>Hello</p>',
    });
    expect(html).toBe(
      '<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1790865035983">' +
        `<strong itemprop="mri" itemid="${ME}">Brandon &lt;Haney&gt;</strong>` +
        '<span itemprop="time" itemid="1790865035983"></span>' +
        '<p itemprop="preview">Hello</p></blockquote>',
    );
  });
});

describe('quotedMessagesProperty', () => {
  test('names the quoted message, its sender and its time as Teams does', () => {
    const property = quotedMessagesProperty({
      id: '1790865035983',
      from: `https://amer.ng.msg.teams.microsoft.com/v1/users/ME/contacts/${ME}`,
    });
    expect(JSON.parse(property)).toEqual([{ messageId: '1790865035983', sender: ME, time: 1790865035983 }]);
  });
});

describe('getReplyTarget', () => {
  beforeEach(() => {
    vi.mocked(chatApi).mockReset();
  });

  test('fetches the original message from the conversation', async () => {
    vi.mocked(chatApi).mockResolvedValue({ id: '5', messagetype: 'RichText/Html', content: '<p>x</p>' });

    await expect(getReplyTarget('48:notes', '5')).resolves.toMatchObject({ id: '5' });
    expect(chatApi).toHaveBeenCalledWith('/v1/users/ME/conversations/48%3Anotes/messages/5');
  });

  test('refuses a deleted message and a system event', async () => {
    vi.mocked(chatApi).mockResolvedValueOnce({
      id: '5',
      messagetype: 'RichText/Html',
      properties: { deletetime: 1792158621093 },
    });
    await expect(getReplyTarget('48:notes', '5')).rejects.toThrow('was deleted');

    vi.mocked(chatApi).mockResolvedValueOnce({ id: '6', messagetype: 'ThreadActivity/AddMember' });
    await expect(getReplyTarget('48:notes', '6')).rejects.toThrow('not a chat message');
  });
});
