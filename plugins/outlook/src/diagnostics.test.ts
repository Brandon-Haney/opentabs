import { afterEach, describe, expect, test, vi } from 'vitest';
import { probeResultSchema, runProbe } from './diagnostics.js';

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
