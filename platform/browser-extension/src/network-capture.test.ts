import { describe, expect, vi, test } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome API stubs — network-capture.ts registers listeners at module level
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).chrome = {
  debugger: { onEvent: { addListener: vi.fn() }, detach: vi.fn(() => Promise.resolve()) },
  tabs: { onRemoved: { addListener: vi.fn() } },
};

const { scrubHeaders } = await import('./network-capture.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scrubHeaders', () => {
  test('returns undefined for undefined input', () => {
    expect(scrubHeaders(undefined)).toBeUndefined();
  });

  test('preserves non-sensitive headers', () => {
    const result = scrubHeaders({ 'Content-Type': 'application/json', Accept: 'text/html' });
    expect(result).toEqual({ 'Content-Type': 'application/json', Accept: 'text/html' });
  });

  describe('existing sensitive headers', () => {
    test('redacts authorization with scheme preserved', () => {
      const result = scrubHeaders({ Authorization: 'Bearer abc123' });
      expect(result).toEqual({ Authorization: 'Bearer [REDACTED]' });
    });

    test('redacts proxy-authorization with scheme preserved', () => {
      const result = scrubHeaders({ 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' });
      expect(result).toEqual({ 'Proxy-Authorization': 'Basic [REDACTED]' });
    });

    test('redacts cookie', () => {
      const result = scrubHeaders({ Cookie: 'session=abc123' });
      expect(result).toEqual({ Cookie: '[REDACTED]' });
    });

    test('redacts set-cookie', () => {
      const result = scrubHeaders({ 'Set-Cookie': 'session=abc123; Path=/' });
      expect(result).toEqual({ 'Set-Cookie': '[REDACTED]' });
    });

    test('redacts x-csrf-token', () => {
      const result = scrubHeaders({ 'X-CSRF-Token': 'token123' });
      expect(result).toEqual({ 'X-CSRF-Token': '[REDACTED]' });
    });

    test('redacts x-xsrf-token', () => {
      const result = scrubHeaders({ 'X-XSRF-Token': 'token456' });
      expect(result).toEqual({ 'X-XSRF-Token': '[REDACTED]' });
    });
  });

  describe('newly added sensitive headers', () => {
    test('redacts x-api-key', () => {
      const result = scrubHeaders({ 'x-api-key': 'sk-abc123' });
      expect(result).toEqual({ 'x-api-key': '[REDACTED]' });
    });

    test('redacts X-Api-Key (mixed case)', () => {
      const result = scrubHeaders({ 'X-Api-Key': 'sk-abc123' });
      expect(result).toEqual({ 'X-Api-Key': '[REDACTED]' });
    });

    test('redacts x-auth-token', () => {
      const result = scrubHeaders({ 'X-Auth-Token': 'eyJhbG...' });
      expect(result).toEqual({ 'X-Auth-Token': '[REDACTED]' });
    });

    test('redacts x-access-token', () => {
      const result = scrubHeaders({ 'X-Access-Token': 'access_xyz' });
      expect(result).toEqual({ 'X-Access-Token': '[REDACTED]' });
    });

    test('redacts x-api-token', () => {
      const result = scrubHeaders({ 'x-api-token': 'tok_789' });
      expect(result).toEqual({ 'x-api-token': '[REDACTED]' });
    });

    test('redacts www-authenticate', () => {
      const result = scrubHeaders({ 'WWW-Authenticate': 'Bearer realm="api"' });
      expect(result).toEqual({ 'WWW-Authenticate': '[REDACTED]' });
    });
  });

  describe('case insensitivity', () => {
    test('redacts regardless of header name casing', () => {
      const result = scrubHeaders({
        'X-API-KEY': 'key1',
        'x-auth-TOKEN': 'key2',
        'X-Access-Token': 'key3',
      });
      expect(result).toEqual({
        'X-API-KEY': '[REDACTED]',
        'x-auth-TOKEN': '[REDACTED]',
        'X-Access-Token': '[REDACTED]',
      });
    });
  });

  describe('mixed headers', () => {
    test('redacts sensitive headers while preserving non-sensitive ones', () => {
      const result = scrubHeaders({
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        'x-api-key': 'sk-test',
        'X-Request-Id': 'req-123',
        'x-auth-token': 'tok-abc',
      });
      expect(result).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer [REDACTED]',
        'x-api-key': '[REDACTED]',
        'X-Request-Id': 'req-123',
        'x-auth-token': '[REDACTED]',
      });
    });
  });
});
