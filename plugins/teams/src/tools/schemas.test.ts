import { describe, expect, test } from 'vitest';
import { isChannelThreadType, mapConversation, threadName } from './schemas.js';

describe('threadName', () => {
  test("names a team's General channel, which has no topic", () => {
    expect(threadName({ threadType: 'space', spaceThreadTopic: 'Project Renaissance' })).toBe('Project Renaissance');
  });

  test('prefers the topic of a chat or other channel', () => {
    expect(threadName({ topic: 'Oracle Fusion', topicThreadTopic: 'Oracle Fusion', spaceThreadTopic: 'Team' })).toBe(
      'Oracle Fusion',
    );
  });

  test('is empty for an unnamed chat', () => {
    expect(threadName({ threadType: 'chat' })).toBe('');
    expect(threadName(undefined)).toBe('');
  });
});

describe('channel threads', () => {
  test('recognizes both kinds of channel and nothing else', () => {
    expect(['space', 'topic', 'chat', 'meeting', ''].map(isChannelThreadType)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test('a listed channel carries its name', () => {
    const conversation = mapConversation({
      id: '19:team@thread.tacv2',
      threadProperties: { threadType: 'space', spaceThreadTopic: 'Project Renaissance' },
    });
    expect(conversation.topic).toBe('Project Renaissance');
    expect(conversation.thread_type).toBe('space');
  });

  test('previews the last message on one line as Teams does, and names an event by its type', () => {
    const preview = (lastMessage: Record<string, unknown>) =>
      mapConversation({ id: '19:a@thread.v2', lastMessage }).last_message_preview;
    const reply =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1"><p itemprop="preview">old</p></blockquote>' +
      '<p>Slide 3: fix the math.</p><p>&nbsp;</p><table><tr><td><p>Item</p></td></tr></table>';
    expect(preview({ messagetype: 'RichText/Html', content: reply })).toBe('Slide 3: fix the math. Item');
    expect(preview({ messagetype: 'RichText/Html', content: `<p>${'word '.repeat(80)}</p>` }).length).toBe(200);
    expect(
      preview({ messagetype: 'Event/Call', content: '<partlist type="ended"><part identity="x"/></partlist>' }),
    ).toBe('[Event/Call]');
    expect(preview({ messagetype: 'Text', content: '' })).toBe('');
  });
});
