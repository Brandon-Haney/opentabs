import { isValidWsOrigin, wsToHttpBase } from './ws-utils.js';
import { describe, expect, test } from 'vitest';

describe('isValidWsOrigin', () => {
  test('valid ws:// URL with matching host passes', () => {
    expect(isValidWsOrigin('ws://localhost:9515/ws', 'http://localhost:9515')).toBe(true);
  });

  test('valid wss:// URL with matching host passes', () => {
    expect(isValidWsOrigin('wss://example.com/ws', 'https://example.com')).toBe(true);
  });

  test('mismatched host rejects', () => {
    expect(isValidWsOrigin('ws://evil.com/ws', 'http://localhost:9515')).toBe(false);
  });

  test('mismatched port rejects', () => {
    expect(isValidWsOrigin('ws://localhost:1234/ws', 'http://localhost:9515')).toBe(false);
  });

  test('non-ws protocol rejects', () => {
    expect(isValidWsOrigin('http://localhost:9515/ws', 'http://localhost:9515')).toBe(false);
  });

  test('ftp protocol rejects', () => {
    expect(isValidWsOrigin('ftp://localhost:9515/ws', 'http://localhost:9515')).toBe(false);
  });

  test('wrong path rejects', () => {
    expect(isValidWsOrigin('ws://localhost:9515/other', 'http://localhost:9515')).toBe(false);
  });

  test('path with trailing suffix rejects', () => {
    expect(isValidWsOrigin('ws://localhost:9515/ws/extra', 'http://localhost:9515')).toBe(false);
  });

  test('malformed URL rejects', () => {
    expect(isValidWsOrigin('not-a-url', 'http://localhost:9515')).toBe(false);
  });
});

describe('wsToHttpBase', () => {
  test('converts ws:// to http://', () => {
    expect(wsToHttpBase('ws://localhost:9515/ws')).toBe('http://localhost:9515');
  });

  test('converts wss:// to https://', () => {
    expect(wsToHttpBase('wss://example.com/ws')).toBe('https://example.com');
  });
});
