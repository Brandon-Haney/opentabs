import { describe, expect, test } from 'vitest';
import { nextPageToken, pageQuery } from './search-paging.js';

const LINK = 'https://outlook.office.com/api/v2.0/me/messages?%24search=%22x%22&%24top=10&%24skip=10';

describe('nextPageToken', () => {
  test('keeps only the paging parameters of the link', () => {
    expect(pageQuery(nextPageToken(LINK, 10) ?? '')).toEqual({ $skip: '10' });
  });

  test('carries a skip token', () => {
    const link = 'https://graph.microsoft.com/v1.0/me/messages?%24skiptoken=abc%3D';
    expect(pageQuery(nextPageToken(link, 10) ?? '')).toEqual({ $skiptoken: 'abc=' });
  });

  test('is null without a link, after an empty page, or for a link with no paging parameters', () => {
    expect(nextPageToken(undefined, 10)).toBeNull();
    expect(nextPageToken(LINK, 0)).toBeNull();
    expect(nextPageToken('https://outlook.office.com/api/v2.0/me/messages?%24top=10', 10)).toBeNull();
    expect(nextPageToken('not a url', 10)).toBeNull();
  });
});

describe('pageQuery', () => {
  test('ignores anything else a token carries', () => {
    expect(pageQuery('$skip=20&$search=other&$filter=x&host=evil.example')).toEqual({ $skip: '20' });
  });
});
