import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as composer from '../compose-message.js';
import * as teamsApi from '../teams-api.js';
import { editMessage } from './edit-message.js';

vi.mock('../teams-api.js', () => ({ chatApi: vi.fn() }));
vi.mock('../compose-message.js', () => ({ composeMessage: vi.fn() }));

const chatApi = vi.mocked(teamsApi.chatApi);
const composeMessage = vi.mocked(composer.composeMessage);

const CHAT = '19:abc@thread.v2';
const PATH = `/v1/users/ME/conversations/${encodeURIComponent(CHAT)}/messages/42`;
const QUOTE =
  '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="17"><strong itemprop="mri">Pat</strong>' +
  '<p itemprop="preview">Is it ready?</p></blockquote>';

/** Serve the original message, and accept the edit. */
const serve = (original: Record<string, unknown>) => {
  chatApi.mockImplementation(async (_path, options) => (options?.method === 'PUT' ? {} : original));
};

const sentEdit = () => chatApi.mock.calls.find(([, options]) => options?.method === 'PUT');

beforeEach(() => {
  chatApi.mockReset();
  composeMessage.mockReset();
});

describe('edit_message', () => {
  test('keeps the quote card and the properties tied to it, and sets mentions from the new text', async () => {
    serve({
      messagetype: 'RichText/Html',
      content: `${QUOTE}\n<p>old</p>`,
      properties: { qtdMsgs: '[{"messageId":"17"}]', files: '[{"title":"a.docx"}]', mentions: '[{"itemid":0}]' },
    });
    composeMessage.mockResolvedValue({
      content: '<p>new <span itemid="0">Pat</span></p>',
      properties: { mentions: '[{"itemid":0,"displayName":"Pat Lee"}]' },
      mentions: [{ text: 'Pat', display_name: 'Pat Lee', email: 'pat@contoso.com' }],
      files: [],
    });

    const result = await editMessage.handle({ conversation_id: CHAT, message_id: '42', text: 'new @[Pat]' });

    expect(composeMessage).toHaveBeenCalledWith(
      { conversationId: CHAT, text: 'new @[Pat]', files: [], fileAccess: 'view' },
      undefined,
    );
    expect(sentEdit()).toEqual([
      PATH,
      {
        method: 'PUT',
        body: {
          content: `${QUOTE}\n<p>new <span itemid="0">Pat</span></p>`,
          messagetype: 'RichText/Html',
          contenttype: 'text',
          properties: {
            qtdMsgs: '[{"messageId":"17"}]',
            files: '[{"title":"a.docx"}]',
            mentions: '[{"itemid":0,"displayName":"Pat Lee"}]',
          },
        },
      },
    ]);
    expect(result).toEqual({
      success: true,
      mentions: [{ text: 'Pat', display_name: 'Pat Lee', email: 'pat@contoso.com' }],
    });
  });

  test('clears the mentions of an edit that leaves them out', async () => {
    serve({ messagetype: 'RichText/Html', content: '<p>old</p>', properties: { mentions: '[{"itemid":0}]' } });
    composeMessage.mockResolvedValue({ content: '<p>plain</p>', properties: {}, mentions: [], files: [] });

    await editMessage.handle({ conversation_id: CHAT, message_id: '42', text: 'plain' });

    const body = sentEdit()?.[1]?.body as { content: string; properties: Record<string, string> };
    expect(body.content).toBe('<p>plain</p>');
    expect(body.properties).toEqual({ mentions: '[]' });
  });

  test('refuses a deleted message or an event, without editing it', async () => {
    serve({ messagetype: 'RichText/Html', content: '', properties: { deletetime: 1793367487562 } });
    await expect(editMessage.handle({ conversation_id: CHAT, message_id: '42', text: 'x' })).rejects.toThrow(
      'was deleted',
    );

    serve({ messagetype: 'Event/Call', content: '<partlist/>' });
    await expect(editMessage.handle({ conversation_id: CHAT, message_id: '42', text: 'x' })).rejects.toThrow(
      'is a Event/Call event',
    );
    expect(sentEdit()).toBeUndefined();
    expect(composeMessage).not.toHaveBeenCalled();
  });
});
