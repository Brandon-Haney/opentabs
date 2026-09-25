import { afterEach, describe, expect, test, vi } from 'vitest';
import { describeMsalCache, msalCacheSchema, probeResultSchema, runProbe } from './diagnostics.js';

const respond = (status: number, headers?: Record<string, string>): Response =>
  new Response(`body-${status}`, { status, headers });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runProbe', () => {
  test('records status, ok, request id and latency for a successful response', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(350.4);
    const run = vi.fn(async () => respond(200, { 'request-id': 'req-1' }));
    const result = await runProbe('graph:/me', '/me', run);
    expect(result).toEqual({
      name: 'graph:/me',
      path: '/me',
      status: 200,
      ok: true,
      latencyMs: 250,
      requestId: 'req-1',
      frontDoor: null,
      error: null,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('reports a failing status with the front-door label and never retries', async () => {
    const run = vi.fn(async () =>
      respond(500, {
        'x-proxyerrorlabel': 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest',
        'x-ms-request-id': 'ms-2',
      }),
    );
    const result = await runProbe('rest:/me', '/me', run);
    expect(result).toMatchObject({
      status: 500,
      ok: false,
      requestId: 'ms-2',
      frontDoor: 'Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest',
      error: null,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('cancels the response body without reading it', async () => {
    const response = respond(200);
    const body = response.body;
    if (body === null) throw new Error('test response must carry a body');
    const cancel = vi.spyOn(body, 'cancel');
    await runProbe('graph:/me', '/me', async () => response);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('captures a thrown network error as "<name>: <message>" with a null status', async () => {
    const run = vi.fn(async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });
    const result = await runProbe('graph:/me', '/me', run);
    expect(result).toMatchObject({
      status: null,
      ok: false,
      requestId: null,
      frontDoor: null,
      error: 'TypeError: Failed to fetch',
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('captures a timeout DOMException by name', async () => {
    const result = await runProbe('ows:/settings', '/ows/v1/OutlookCloudSettings/settings', async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(result.error).toBe('TimeoutError: The operation was aborted due to timeout');
  });

  test('stringifies a thrown non-Error value', async () => {
    const result = await runProbe('graph:/me', '/me', async () => {
      throw 'plain failure';
    });
    expect(result.error).toBe('plain failure');
  });

  test('echoes the caller-supplied path label verbatim and never a URL', async () => {
    const result = await runProbe('graph:/shares', '/shares/{shareId}/driveItem', async () =>
      respond(404, { 'client-request-id': 'c-3' }),
    );
    expect(result.path).toBe('/shares/{shareId}/driveItem');
    expect(result.requestId).toBe('c-3');
    expect(JSON.stringify(result)).not.toContain('https://');
  });

  test('never reports a negative latency', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(500).mockReturnValueOnce(499);
    const result = await runProbe('graph:/me', '/me', async () => respond(200));
    expect(result.latencyMs).toBe(0);
  });
});

describe('probeResultSchema', () => {
  test('accepts every shape runProbe produces', async () => {
    const results = await Promise.all([
      runProbe('a', '/a', async () => respond(200, { 'request-id': 'r' })),
      runProbe('b', '/b', async () => respond(503, { 'x-proxyerrorlabel': 'X::OnHttpRequest' })),
      runProbe('c', '/c', async () => {
        throw new TypeError('Failed to fetch');
      }),
    ]);
    for (const result of results) {
      expect(probeResultSchema.parse(result)).toEqual(result);
    }
  });

  test('rejects a fractional latency and a non-integer status', () => {
    const base = { name: 'a', path: '/a', ok: true, requestId: null, frontDoor: null, error: null };
    expect(probeResultSchema.safeParse({ ...base, status: 200, latencyMs: 1.5 }).success).toBe(false);
    expect(probeResultSchema.safeParse({ ...base, status: 200.5, latencyMs: 1 }).success).toBe(false);
    expect(probeResultSchema.safeParse({ ...base, status: null, latencyMs: 0 }).success).toBe(true);
  });
});

/** A Storage stand-in holding the given key/value pairs in insertion order. */
const storageOf = (entries: Record<string, string>): Pick<Storage, 'length' | 'key' | 'getItem'> => {
  const keys = Object.keys(entries);
  return { length: keys.length, key: index => keys[index] ?? null, getItem: key => entries[key] ?? null };
};

const plaintextAccessToken = JSON.stringify({
  credentialType: 'AccessToken',
  secret: 'eyJ-plaintext-secret',
  target: 'https://graph.microsoft.com/.default',
  expiresOn: '1790310000',
});
const encryptedEntry = JSON.stringify({ id: 'cookie-key-id', nonce: 'bm9uY2U', data: 'Y2lwaGVy', lastUpdatedAt: '1' });

describe('describeMsalCache', () => {
  test('reports plaintext when readable access tokens are cached', () => {
    const output = describeMsalCache(storageOf({ 'msal.2|at': plaintextAccessToken, unrelated: 'x' }));

    expect(output).toEqual({ state: 'plaintext', plaintextAccessTokens: 1, encryptedEntries: 0 });
    expect(msalCacheSchema.parse(output)).toEqual(output);
  });

  test('reports encrypted when entries are { id, nonce, data } and none are readable', () => {
    expect(describeMsalCache(storageOf({ 'msal.2|at': encryptedEntry, 'msal.2|rt': encryptedEntry }))).toEqual({
      state: 'encrypted',
      plaintextAccessTokens: 0,
      encryptedEntries: 2,
    });
  });

  test('reports mixed when both kinds of entry are present', () => {
    expect(describeMsalCache(storageOf({ a: plaintextAccessToken, b: encryptedEntry })).state).toBe('mixed');
  });

  test('reports empty and ignores non-MSAL and unparseable values', () => {
    expect(
      describeMsalCache(storageOf({ a: 'plain text', b: '{not json', c: '[1,2]', d: '{"credentialType":"IdToken"}' })),
    ).toEqual({ state: 'empty', plaintextAccessTokens: 0, encryptedEntries: 0 });
  });

  test('never returns a key, value or secret', () => {
    const serialized = JSON.stringify(describeMsalCache(storageOf({ 'msal.2|at': plaintextAccessToken })));

    expect(serialized).not.toContain('eyJ-plaintext-secret');
    expect(serialized).not.toContain('msal.2|at');
  });

  test('reports what it counted when storage access throws', () => {
    const throwing = {
      length: 2,
      key: (index: number) => (index === 0 ? 'a' : 'b'),
      getItem: (key: string) => {
        if (key === 'b') throw new DOMException('denied', 'SecurityError');
        return plaintextAccessToken;
      },
    };

    expect(describeMsalCache(throwing)).toEqual({ state: 'plaintext', plaintextAccessTokens: 1, encryptedEntries: 0 });
  });
});
