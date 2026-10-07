import { describe, expect, test } from 'vitest';
import { extractQuotedThread } from './drafts.js';

const AUTHORED = '<div style="font-family:Aptos">Old text.</div><br><p>Signature</p>';
const HEADER = '<div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Sender</div><div>Original body</div></body></html>';

describe('extractQuotedThread', () => {
  test('returns the separator rule and quote header of an Exchange reply', () => {
    const html = `<html><body>${AUTHORED}<hr tabindex="-1" style="width:98%">${HEADER}`;
    expect(extractQuotedThread(html)).toBe(`<hr tabindex="-1" style="width:98%">${HEADER}`);
  });

  test('carries the original message styles that Exchange hoisted above the quote', () => {
    const style = '<style>\r\n.a { color: red }\r\n</style>';
    const html = `<html><head><meta charset="utf-8"></head><body>${AUTHORED}<meta name="viewport" content="x">${style}<hr>${HEADER}`;
    expect(extractQuotedThread(html)).toBe(
      `<meta charset="utf-8"><meta name="viewport" content="x">${style}<hr>${HEADER}`,
    );
  });

  test('starts at the quote header when no separator rule sits above it', () => {
    const html = `${AUTHORED}<hr><p>A rule the author wrote</p>${HEADER}`;
    expect(extractQuotedThread(html)).toBe(HEADER);
  });

  test('starts at the Outlook on the web anchor when present', () => {
    const html = `${AUTHORED}<div id="appendonsend"></div><hr>${HEADER}`;
    expect(extractQuotedThread(html)).toBe(`<div id="appendonsend"></div><hr>${HEADER}`);
  });

  test('returns null for a standalone draft with no quoted history', () => {
    expect(extractQuotedThread(`<html><body>${AUTHORED}</body></html>`)).toBeNull();
    expect(extractQuotedThread('')).toBeNull();
  });
});
