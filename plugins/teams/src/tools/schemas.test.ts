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
});
