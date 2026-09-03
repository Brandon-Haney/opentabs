import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sanitizeErrorDetails, sanitizeErrorMessage } from './sanitize-error.js';

describe('sanitizeErrorMessage', () => {
  describe('Windows absolute paths', () => {
    test('replaces backslash paths with [PATH]', () => {
      expect(sanitizeErrorMessage('Error at C:\\Users\\bob\\file.ts')).toBe('Error at [PATH]');
    });

    test('replaces forward-slash paths with [PATH]', () => {
      expect(sanitizeErrorMessage('Error at D:/Projects/app/src/index.ts')).toBe('Error at [PATH]');
    });
  });

  describe('Unix absolute paths', () => {
    test('replaces multi-segment paths with [PATH]', () => {
      expect(sanitizeErrorMessage('Error at /home/user/project/file.ts')).toBe('Error at [PATH]');
    });

    test('single segment path is NOT replaced', () => {
      expect(sanitizeErrorMessage('GET /api returned 404')).toBe('GET /api returned 404');
    });
  });

  describe('URLs', () => {
    test('strips sensitive URL content', () => {
      const result = sanitizeErrorMessage('Failed to fetch https://api.example.com/v1/data');
      expect(result).not.toContain('api.example.com');
      expect(result).not.toContain('/v1/data');
    });

    test('strips http URL content', () => {
      const result = sanitizeErrorMessage('Request to http://internal.corp/api failed');
      expect(result).not.toContain('internal.corp');
      expect(result).not.toContain('/api');
    });

    test('URL with no path is still sanitized', () => {
      const result = sanitizeErrorMessage('See https://example.com');
      expect(result).not.toContain('example.com');
    });
  });

  describe('localhost references', () => {
    test('replaces localhost:port with [LOCALHOST]', () => {
      expect(sanitizeErrorMessage('Connection refused at localhost:9515')).toBe('Connection refused at [LOCALHOST]');
    });
  });

  describe('IPv4 addresses', () => {
    test('replaces IPv4 addresses with [IP]', () => {
      expect(sanitizeErrorMessage('Cannot reach 192.168.1.1')).toBe('Cannot reach [IP]');
    });
  });

  describe('IPv6 addresses', () => {
    // A clock time is colon-separated and all hex digits, so it reaches the same
    // regex an IPv6 literal does. Nothing valid in IPv6 has exactly two colons and
    // no `::`, which is what keeps these intact.
    test('leaves a clock time alone', () => {
      expect(sanitizeErrorMessage('request started at 10:30:45')).toBe('request started at 10:30:45');
      expect(sanitizeErrorMessage('Error at 23:59:59 UTC')).toBe('Error at 23:59:59 UTC');
      expect(sanitizeErrorMessage('elapsed 01:02:03.456')).toBe('elapsed 01:02:03.456');
    });

    test('still replaces an all-decimal IPv6 address, which spells out every group', () => {
      expect(sanitizeErrorMessage('route via 1:2:3:4:5:6:7:8 failed')).toBe('route via [IP] failed');
    });
    test('replaces loopback ::1 with [IP]', () => {
      expect(sanitizeErrorMessage('connect ECONNREFUSED ::1')).toBe('connect ECONNREFUSED [IP]');
    });

    test('replaces bracketed IPv6 with port [::1]:9515 with [IP]', () => {
      expect(sanitizeErrorMessage('connect ECONNREFUSED [::1]:9515')).toBe('connect ECONNREFUSED [IP]');
    });

    test('replaces full IPv6 address 2001:db8::1 with [IP]', () => {
      expect(sanitizeErrorMessage('Cannot reach 2001:db8::1')).toBe('Cannot reach [IP]');
    });

    test('replaces IPv6 with zone ID fe80::1%eth0 with [IP]', () => {
      expect(sanitizeErrorMessage('link-local fe80::1%eth0 unreachable')).toBe('link-local [IP] unreachable');
    });

    test('replaces compressed IPv6 ::ffff:127.0.0.1 with [IP]', () => {
      expect(sanitizeErrorMessage('mapped ::ffff:127.0.0.1 rejected')).toBe('mapped [IP] rejected');
    });

    test('replaces bracketed IPv6 without port [2001:db8::1] with [IP]', () => {
      expect(sanitizeErrorMessage('target [2001:db8::1] unreachable')).toBe('target [IP] unreachable');
    });

    test('leaves a ::-delimited Microsoft proxy label intact', () => {
      const label = 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest';
      expect(sanitizeErrorMessage(label)).toBe(label);
    });

    test('leaves ::-delimited identifiers whose segments are all hex intact', () => {
      expect(sanitizeErrorMessage('Http::Proxy::Deadbeef::OnRequest')).toBe('Http::Proxy::Deadbeef::OnRequest');
      expect(sanitizeErrorMessage('Foo::abc::Bar')).toBe('Foo::abc::Bar');
    });

    test('leaves scope operators and a spaced :: intact', () => {
      expect(sanitizeErrorMessage('std::abs')).toBe('std::abs');
      expect(sanitizeErrorMessage('Foo :: Bar')).toBe('Foo :: Bar');
    });
  });

  describe('truncation', () => {
    test('truncates messages over 500 characters', () => {
      const longMessage = 'A'.repeat(600);
      const result = sanitizeErrorMessage(longMessage);
      expect(result.length).toBe(500);
      expect(result.endsWith('...')).toBe(true);
    });

    test('does not truncate messages at exactly 500 characters', () => {
      const message = 'B'.repeat(500);
      expect(sanitizeErrorMessage(message)).toBe(message);
    });
  });

  describe('passthrough', () => {
    test('clean strings pass through unchanged', () => {
      expect(sanitizeErrorMessage('Tool execution failed')).toBe('Tool execution failed');
    });

    test('empty string passes through', () => {
      expect(sanitizeErrorMessage('')).toBe('');
    });
  });

  describe('combined patterns', () => {
    test('handles message with multiple sensitive values', () => {
      const result = sanitizeErrorMessage(
        'Error at /home/user/app.ts: fetch https://api.example.com failed from 10.0.0.1',
      );
      expect(result).not.toContain('/home/user');
      expect(result).not.toContain('api.example.com');
      expect(result).not.toContain('10.0.0.1');
      expect(result).toContain('[PATH]');
      expect(result).toContain('[IP]');
    });
  });
});

describe('sanitizeErrorDetails', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('sanitizes string leaves and preserves numbers, booleans, and null', () => {
    expect(
      sanitizeErrorDetails({
        configPath: '/home/user/.opentabs/config.json',
        status: 500,
        retryable: true,
        requestId: null,
      }),
    ).toEqual({ configPath: '[PATH]', status: 500, retryable: true, requestId: null });
  });

  test('strips a URL with an item id from a string leaf', () => {
    const sanitized = sanitizeErrorDetails({ endpoint: 'https://outlook.office.com/api/v2.0/me/messages/AAMk' });
    expect(sanitized?.endpoint).not.toContain('outlook.office.com');
    expect(sanitized?.endpoint).not.toContain('AAMk');
  });

  test('sanitizes keys as well as values', () => {
    expect(sanitizeErrorDetails({ '/home/user/secret.txt': 500 })).toEqual({ '[PATH]': 500 });
    const urlKeyed = sanitizeErrorDetails({ 'https://outlook.office.com/api/v2.0/me/messages/AAMk': 500 });
    expect(Object.keys(urlKeyed ?? {})).toHaveLength(1);
    expect(Object.keys(urlKeyed ?? {})[0]).not.toContain('outlook.office.com');
  });

  test('keeps every entry whose key collides after sanitization', () => {
    const sanitized = sanitizeErrorDetails({ 'https://a.com/x': 1, 'https://b.com/y': 2, 'https://c.com/z': 3 });
    const keys = Object.keys(sanitized ?? {});
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(`${keys[0]}#2`);
    expect(keys[2]).toBe(`${keys[0]}#3`);
    expect(Object.values(sanitized ?? {})).toEqual([1, 2, 3]);
    for (const key of keys) {
      expect(key).not.toMatch(/a\.com|b\.com|c\.com/);
    }
  });

  test('drops __proto__, constructor, and prototype keys', () => {
    const details = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"ok":1}') as Record<
      string,
      unknown
    >;
    const sanitized = sanitizeErrorDetails(details);
    expect(sanitized).toEqual({ ok: 1 });
    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
    expect((sanitized as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('keeps at most 64 keys per object', () => {
    const details: Record<string, number> = {};
    for (let i = 0; i < 65; i++) details[`k${i}`] = i;
    const sanitized = sanitizeErrorDetails(details);
    expect(Object.keys(sanitized ?? {})).toHaveLength(64);
    expect(sanitized).toHaveProperty('k63');
    expect(sanitized).not.toHaveProperty('k64');
  });

  test('walks nested objects to depth 2 and truncates deeper containers', () => {
    expect(sanitizeErrorDetails({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: '[TRUNCATED]' } } });
    expect(sanitizeErrorDetails({ a: { b: { c: '/var/log/app.log' } } })).toEqual({ a: { b: { c: '[PATH]' } } });
  });

  test('walks arrays, preserving positions with null for unsupported entries', () => {
    expect(sanitizeErrorDetails({ list: [1, '/var/log/app.log', undefined, () => 1, true] })).toEqual({
      list: [1, '[PATH]', null, null, true],
    });
    expect(sanitizeErrorDetails({ list: [[[1]]] })).toEqual({ list: [['[TRUNCATED]']] });
  });

  test('omits undefined, function, symbol, and bigint values from objects', () => {
    expect(
      sanitizeErrorDetails({
        keep: 'yes',
        u: undefined,
        f: () => 1,
        s: Symbol('s'),
        b: BigInt(1),
      }),
    ).toEqual({ keep: 'yes' });
  });

  test('returns undefined and warns when the sanitized JSON exceeds 4096 characters', () => {
    const sanitized = sanitizeErrorDetails({ a: 'x'.repeat(400), b: 'y'.repeat(400), c: 'z'.repeat(400) });
    // Three 400-char strings serialize under 4096; add enough keys to cross it.
    expect(sanitized).toBeDefined();
    const oversized: Record<string, string> = {};
    for (let i = 0; i < 20; i++) oversized[`k${i}`] = 'x'.repeat(400);
    expect(sanitizeErrorDetails(oversized)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('exceeds 4096');
  });

  test('returns an empty object for an empty object', () => {
    expect(sanitizeErrorDetails({})).toEqual({});
  });

  test('returns undefined for non-object inputs', () => {
    expect(sanitizeErrorDetails(null)).toBeUndefined();
    expect(sanitizeErrorDetails([1, 2])).toBeUndefined();
    expect(sanitizeErrorDetails('string')).toBeUndefined();
    expect(sanitizeErrorDetails(42)).toBeUndefined();
  });

  test('a Microsoft proxy error payload round-trips unchanged', () => {
    const details = {
      proxyErrorLabel: 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest',
      hresult: '0x80070036',
      status: 500,
    };
    expect(sanitizeErrorDetails(details)).toEqual(details);
  });
});
