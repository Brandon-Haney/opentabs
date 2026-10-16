import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getReplyTarget, quotedMessagesProperty, replyPreview, replyQuoteHtml } from './reply-quote.js';
import { chatApi } from './teams-api.js';

vi.mock('./teams-api.js', () => ({ chatApi: vi.fn() }));

const ME = '8:orgid:dd24679a-bbcd-4624-88f0-cf4efd4fdedc';

describe('replyPreview', () => {
  test('flattens the message HTML to one line of text', () => {
    expect(replyPreview({ content: '<p>Line one<br>line &amp; two</p>\n<p>Next&nbsp;para</p>' })).toBe(
      'Line one line & two Next para',
    );
  });

  test('keeps code indentation, turning each non-breaking space into a plain one', () => {
    expect(replyPreview({ content: '<pre><code>do&nbsp;{<br> &nbsp;&nbsp; $p&nbsp;=&nbsp;0</code></pre>' })).toBe(
      'do {    $p = 0',
    );
  });

  test('leaves out the message the original was itself replying to', () => {
    const content =
      '<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1"><strong>A</strong>' +
      '<p itemprop="preview">older</p></blockquote>\n<p>newer</p>';
    expect(replyPreview({ content })).toBe('newer');
  });

  test('marks each image and each attached file as the Teams client does', () => {
    const files = JSON.stringify([{ title: 'Plan.docx' }]);
    expect(replyPreview({ content: '<p>See this <img src="x" alt="image"></p>', properties: { files } })).toBe(
      'See this 📷 📄 ',
    );
  });

  test('previews a shared file as its link text and one file marker, as Teams wrote it', () => {
    const content =
      '<p><a href="https://x.sharepoint.com/a.docx?d=1&amp;e=2" itemtype="http://schema.skype.com/HyperLink/Files" ' +
      'itemid="EA4A">Plan &amp; Budget.docx</a></p>';
    const files = JSON.stringify([{ title: 'Plan & Budget.docx' }]);
    expect(replyPreview({ content, properties: { files } })).toBe('Plan & Budget.docx 📄 ');
  });

  test('previews a message with nothing to show as a single space', () => {
    expect(replyPreview({ content: '<p> </p>' })).toBe(' ');
  });

  test('cuts a long message short', () => {
    const preview = replyPreview({ content: `<p>${'word '.repeat(100)}</p>` });
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview.endsWith('…')).toBe(true);
  });
});

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
