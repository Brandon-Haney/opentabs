import { describe, expect, test } from 'vitest';
import { nextPageToken, pageQuery } from './chat-paging.js';

const LINK =
  'https://teams.microsoft.com/api/chatsvc/amer/v1/users/ME/conversations/48:notes/messages?startTime=1&syncState=abc%3D&pageSize=5&view=msnp24Equivalent';

describe('nextPageToken', () => {
  test('keeps only the paging parameters of the link', () => {
    const token = nextPageToken(LINK, 5);
    expect(token).toBe('syncState=abc%3D&startTime=1&view=msnp24Equivalent');
    expect(token).not.toContain('teams.microsoft.com');
  });

  test('is null with no link, an unusable link, or a page with no items', () => {
    expect(nextPageToken(undefined, 5)).toBeNull();
    expect(nextPageToken('not a url', 5)).toBeNull();
    expect(nextPageToken('https://teams.microsoft.com/x?pageSize=5', 5)).toBeNull();
    expect(nextPageToken(LINK, 0)).toBeNull();
  });
});

describe('pageQuery', () => {
  test('round-trips a token into query parameters', () => {
    expect(pageQuery('syncState=abc%3D&startTime=1&view=msnp24Equivalent')).toEqual({
      syncState: 'abc=',
      startTime: '1',
      view: 'msnp24Equivalent',
    });
  });

  test('ignores anything a token adds beyond the paging parameters', () => {
    expect(pageQuery('syncState=abc&redirect=https://example.com&pageSize=9999')).toEqual({ syncState: 'abc' });
  });
});
