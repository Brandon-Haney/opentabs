import { describe, expect, test } from 'vitest';
import { fnv1a32Hex, TOKEN_FINGERPRINT_LENGTH, tokenFingerprint } from './token-fingerprint.js';

const JWT_LIKE = `eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.${'A'.repeat(1400)}.${'b'.repeat(86)}`;

describe('fnv1a32Hex', () => {
  test('matches the reference FNV-1a 32-bit vectors', () => {
    expect(fnv1a32Hex('')).toBe('811c9dc5');
    expect(fnv1a32Hex('a')).toBe('e40c292c');
    expect(fnv1a32Hex('foobar')).toBe('bf9cf968');
  });

  test('always yields exactly eight lowercase hex digits', () => {
    for (const input of ['', 'a', 'hello world', JWT_LIKE]) {
      expect(fnv1a32Hex(input)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test('is deterministic and sensitive to a single-character change', () => {
    expect(fnv1a32Hex(JWT_LIKE)).toBe(fnv1a32Hex(JWT_LIKE));
    expect(fnv1a32Hex(JWT_LIKE)).not.toBe(fnv1a32Hex(`${JWT_LIKE.slice(0, -1)}c`));
  });
});

describe('tokenFingerprint', () => {
  test('keeps the last four hex digits of the hash', () => {
    expect(TOKEN_FINGERPRINT_LENGTH).toBe(4);
    expect(tokenFingerprint('')).toBe('9dc5');
    expect(tokenFingerprint('a')).toBe('292c');
    expect(tokenFingerprint(JWT_LIKE)).toBe(fnv1a32Hex(JWT_LIKE).slice(-4));
  });

  test('never echoes the secret', () => {
    const fingerprint = tokenFingerprint(JWT_LIKE);
    expect(fingerprint).toMatch(/^[0-9a-f]{4}$/);
    expect(fingerprint.length).toBeLessThan(JWT_LIKE.length);
  });
});
