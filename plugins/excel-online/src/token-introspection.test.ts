import { describe, expect, test } from 'vitest';
import { audienceOf, decodeJwtClaims, scopesOf } from './token-introspection.js';

const base64url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const jwt = (claims: Record<string, unknown>): string =>
  `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}.signature`;

describe('decodeJwtClaims', () => {
  test('decodes the payload of a three-segment token, including base64url characters', () => {
    const claims = { aud: 'https://graph.microsoft.com', scp: 'Files.ReadWrite.All', name: 'Zoë ~?>' };
    expect(decodeJwtClaims(jwt(claims))).toEqual(claims);
  });

  test('tolerates a payload without base64 padding', () => {
    const payload = base64url('{"aud":"x"}');
    expect(payload.endsWith('=')).toBe(false);
    expect(decodeJwtClaims(`h.${payload}.s`)).toEqual({ aud: 'x' });
  });

  test('returns null for an opaque token, a malformed payload, or a non-object payload', () => {
    expect(decodeJwtClaims('EwB4A8l6BAAU')).toBeNull();
    expect(decodeJwtClaims('a..c')).toBeNull();
    expect(decodeJwtClaims('a.%%%.c')).toBeNull();
    expect(decodeJwtClaims(`a.${base64url('[1,2]')}.c`)).toBeNull();
    expect(decodeJwtClaims(`a.${base64url('"text"')}.c`)).toBeNull();
    expect(decodeJwtClaims(`a.${base64url('{}')}.c.d`)).toBeNull();
  });
});

describe('audienceOf', () => {
  test('reduces a URL audience to its host', () => {
    expect(audienceOf({ aud: 'https://graph.microsoft.com' })).toBe('graph.microsoft.com');
    expect(audienceOf({ aud: 'https://graph.microsoft.com/' })).toBe('graph.microsoft.com');
  });

  test('returns an application-id audience verbatim', () => {
    expect(audienceOf({ aud: '00000003-0000-0000-c000-000000000000' })).toBe('00000003-0000-0000-c000-000000000000');
  });

  test('is null without a string audience', () => {
    expect(audienceOf(null)).toBeNull();
    expect(audienceOf({})).toBeNull();
    expect(audienceOf({ aud: '' })).toBeNull();
    expect(audienceOf({ aud: ['a', 'b'] })).toBeNull();
  });
});

describe('scopesOf', () => {
  test('splits the scp claim on whitespace and drops empty entries', () => {
    expect(scopesOf({ scp: 'Files.ReadWrite.All  Sites.ReadWrite.All ' })).toEqual([
      'Files.ReadWrite.All',
      'Sites.ReadWrite.All',
    ]);
  });

  test('is empty without a string scp claim', () => {
    expect(scopesOf(null)).toEqual([]);
    expect(scopesOf({})).toEqual([]);
    expect(scopesOf({ scp: 42 })).toEqual([]);
  });
});
