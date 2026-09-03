import { describe, expect, test } from 'vitest';
import { bearerTokenExpiry, jwtClaims } from './jwt-claims.js';

const encode = (payload: unknown): string =>
  btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>): string => `eyJhbGciOiJub25lIn0.${encode(claims)}.sig`;

describe('jwtClaims', () => {
  test('decodes the base64url payload of a JWT', () => {
    expect(jwtClaims(jwt({ aud: 'https://graph.microsoft.com', exp: 1700000000 }))).toEqual({
      aud: 'https://graph.microsoft.com',
      exp: 1700000000,
    });
  });

  test('returns null for an opaque token, a non-JSON payload, or a non-object payload', () => {
    expect(jwtClaims('opaque-token')).toBeNull();
    expect(jwtClaims('a.!!!.c')).toBeNull();
    expect(jwtClaims(`a.${encode(['array'])}.c`)).toBeNull();
  });
});

describe('bearerTokenExpiry', () => {
  const now = 1_700_000_000;

  test('uses the exp claim of a JWT, including one already in the past', () => {
    expect(bearerTokenExpiry(jwt({ exp: now + 3600 }), now, 600)).toBe(now + 3600);
    expect(bearerTokenExpiry(jwt({ exp: now - 5 }), now, 600)).toBe(now - 5);
    expect(bearerTokenExpiry(jwt({ exp: 1700003599.9 }), now, 600)).toBe(1700003599);
  });

  test('falls back to now + ttl for an opaque token or a JWT without a numeric exp', () => {
    expect(bearerTokenExpiry('opaque-token', now, 600)).toBe(now + 600);
    expect(bearerTokenExpiry(jwt({ aud: 'x' }), now, 600)).toBe(now + 600);
    expect(bearerTokenExpiry(jwt({ exp: 'soon' }), now, 600)).toBe(now + 600);
  });
});
