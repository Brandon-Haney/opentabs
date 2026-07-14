import { describe, expect, test } from 'vitest';

// Stub the Chrome APIs that network-capture.ts (a transitive import) registers
// listeners on at module load, then dynamically import the module under test so
// the stub is in place first.
(globalThis as Record<string, unknown>).chrome = {
  debugger: { onEvent: { addListener: () => {} }, onDetach: { addListener: () => {} } },
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildReplayHeaders, deriveTargetUrl } = await import('./frame-bridge-rpc.js');

describe('deriveTargetUrl', () => {
  test('replaces the method segment and preserves the query string', () => {
    expect(
      deriveTargetUrl(
        'https://usc-excel.officeapps.live.com/x/_vti_bin/EwaInternalWebService.json/GetSessionStatus?waccluster=PUS1',
        'EwaInternalWebService.json/',
        'FreezeOrUnfreezePanes',
      ),
    ).toBe(
      'https://usc-excel.officeapps.live.com/x/_vti_bin/EwaInternalWebService.json/FreezeOrUnfreezePanes?waccluster=PUS1',
    );
  });

  test('works when the donor URL has no query string', () => {
    expect(deriveTargetUrl('https://host/a/Svc.json/Foo', 'Svc.json/', 'Bar')).toBe('https://host/a/Svc.json/Bar');
  });

  test('throws when the marker is absent from the donor URL', () => {
    expect(() => deriveTargetUrl('https://host/other/Foo', 'Svc.json/', 'Bar')).toThrow(/marker/);
  });
});

describe('buildReplayHeaders', () => {
  test('strips headers a fetch cannot set (case-insensitive) and keeps the rest', () => {
    const result = buildReplayHeaders({
      'Content-Type': 'application/json',
      'X-AccessToken': 'jwt',
      haep: '2',
      Cookie: 'a=b',
      Host: 'example.com',
      'Content-Length': '10',
      Origin: 'https://x',
      Referer: 'https://x/page',
      'User-Agent': 'UA',
      DNT: '1',
      'sec-ch-ua': '"Chromium"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });
    expect(result).toEqual({ 'Content-Type': 'application/json', 'X-AccessToken': 'jwt', haep: '2' });
  });

  test('refreshes X-CorrelationId with a new value, preserving the key casing', () => {
    const result = buildReplayHeaders({ 'X-CorrelationId': 'old-id', 'X-AccessToken': 'jwt' });
    expect(result['X-CorrelationId']).toBeDefined();
    expect(result['X-CorrelationId']).not.toBe('old-id');
    expect(result['X-CorrelationId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(result['X-AccessToken']).toBe('jwt');
  });

  test('leaves headers untouched when there is no correlation id', () => {
    expect(buildReplayHeaders({ 'X-AccessToken': 'jwt' })).toEqual({ 'X-AccessToken': 'jwt' });
  });
});
