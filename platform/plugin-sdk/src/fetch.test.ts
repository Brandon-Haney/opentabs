import { ToolError } from './errors.js';
import { fetchFromPage, fetchJSON, postJSON } from './fetch.js';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Test HTTP server — lightweight alternative to fetch mocking
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createServer>;
let baseUrl: string;

/** Tracks how many times /flaky has been called (for flaky endpoint testing) */
let flakyCallCount = 0;

beforeAll(
  () =>
    new Promise<void>(resolve => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (url.pathname === '/ok') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
          return;
        }

        if (url.pathname === '/text') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('plain text response');
          return;
        }

        if (url.pathname === '/error-404') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        if (url.pathname === '/error-401') {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        if (url.pathname === '/error-403') {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        if (url.pathname === '/error-429') {
          res.writeHead(429, { 'Retry-After': '30' });
          res.end('Too Many Requests');
          return;
        }

        if (url.pathname === '/error-429-no-header') {
          res.writeHead(429);
          res.end('Too Many Requests');
          return;
        }

        if (url.pathname === '/error-500') {
          res.writeHead(500);
          res.end('Internal Server Error');
          return;
        }

        if (url.pathname === '/error-503') {
          res.writeHead(503, { 'Retry-After': '60' });
          res.end('Service Unavailable');
          return;
        }

        if (url.pathname === '/invalid-json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('this is not json');
          return;
        }

        if (url.pathname === '/echo-post') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: body }));
          });
          return;
        }

        if (url.pathname === '/echo-headers') {
          const contentType = req.headers['content-type'] ?? null;
          const credentials = req.headers['cookie'] ?? null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ contentType, hasCookies: credentials !== null }));
          return;
        }

        if (url.pathname === '/slow') {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ slow: true }));
          }, 5_000);
          return;
        }

        if (url.pathname === '/flaky') {
          flakyCallCount++;
          if (flakyCallCount <= 2) {
            res.writeHead(503);
            res.end('Service Unavailable');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (url.pathname === '/no-content') {
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      });
      server.listen(0, () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://localhost:${String(addr.port)}`;
        resolve();
      });
    }),
);

afterEach(() => {
  flakyCallCount = 0;
});

afterAll(
  () =>
    new Promise<void>(resolve => {
      server.close(() => resolve());
    }),
);

// ---------------------------------------------------------------------------
// fetchFromPage
// ---------------------------------------------------------------------------

describe('fetchFromPage', () => {
  test('returns Response for successful request', async () => {
    const response = await fetchFromPage(`${baseUrl}/ok`);
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { status: string };
    expect(data).toEqual({ status: 'success' });
  });

  test('includes credentials: include by default', async () => {
    const response = await fetchFromPage(`${baseUrl}/text`);
    expect(response.ok).toBe(true);
  });

  test('throws ToolError with not_found category on 404 status', async () => {
    try {
      await fetchFromPage(`${baseUrl}/error-404`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('NOT_FOUND');
      expect(toolError.category).toBe('not_found');
      expect(toolError.retryable).toBe(false);
      expect(toolError.message).toContain('HTTP 404');
      expect(toolError.message).toContain('Not Found');
    }
  });

  test('throws ToolError with auth category on 401 status', async () => {
    try {
      await fetchFromPage(`${baseUrl}/error-401`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('AUTH_ERROR');
      expect(toolError.category).toBe('auth');
      expect(toolError.retryable).toBe(false);
    }
  });

  test('throws ToolError with auth category on 403 status', async () => {
    try {
      await fetchFromPage(`${baseUrl}/error-403`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('AUTH_ERROR');
      expect(toolError.category).toBe('auth');
      expect(toolError.retryable).toBe(false);
    }
  });

  test('throws ToolError with rate_limit category on 429 status with Retry-After', async () => {
    try {
      await fetchFromPage(`${baseUrl}/error-429`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('RATE_LIMITED');
      expect(toolError.category).toBe('rate_limit');
      expect(toolError.retryable).toBe(true);
      expect(toolError.retryAfterMs).toBe(30_000);
    }
  });

  test('throws ToolError with rate_limit category on 429 without Retry-After', async () => {
    try {
      await fetchFromPage(`${baseUrl}/error-429-no-header`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('RATE_LIMITED');
      expect(toolError.category).toBe('rate_limit');
      expect(toolError.retryable).toBe(true);
      expect(toolError.retryAfterMs).toBeUndefined();
    }
  });

  test('throws retryable ToolError with internal category on 500 status', async () => {
    try {
      await fetchFromPage(`${baseUrl}/error-500`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('http_error');
      expect(toolError.category).toBe('internal');
      expect(toolError.retryable).toBe(true);
      expect(toolError.message).toContain('HTTP 500');
      expect(toolError.message).toContain('Internal Server Error');
    }
  });

  test('throws retryable ToolError with retryAfterMs on 503 status', async () => {
    try {
      await fetchFromPage(`${baseUrl}/error-503`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('http_error');
      expect(toolError.category).toBe('internal');
      expect(toolError.retryable).toBe(true);
      expect(toolError.retryAfterMs).toBe(60_000);
      expect(toolError.message).toContain('HTTP 503');
    }
  });

  test('throws ToolError with timeout category when request times out', async () => {
    try {
      await fetchFromPage(`${baseUrl}/slow`, { timeout: 100 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('TIMEOUT');
      expect(toolError.category).toBe('timeout');
      expect(toolError.retryable).toBe(true);
      expect(toolError.message).toContain('timed out after 100ms');
    }
  });

  test('throws ToolError with aborted code when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await fetchFromPage(`${baseUrl}/ok`, { signal: controller.signal });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('aborted');
    }
  });

  test('merges custom headers with defaults', async () => {
    const response = await fetchFromPage(`${baseUrl}/echo-headers`, {
      headers: { 'X-Custom': 'test' },
    });
    expect(response.ok).toBe(true);
  });

  test('throws ToolError with internal category and retryable for network errors', async () => {
    try {
      await fetchFromPage('http://localhost:1/nonexistent');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('network_error');
      expect(toolError.category).toBe('internal');
      expect(toolError.retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchJSON
// ---------------------------------------------------------------------------

describe('fetchJSON', () => {
  test('returns parsed JSON for successful request', async () => {
    const data = await fetchJSON<{ status: string }>(`${baseUrl}/ok`);
    expect(data).toEqual({ status: 'success' });
  });

  test('throws ToolError with validation category on invalid JSON', async () => {
    try {
      await fetchJSON(`${baseUrl}/text`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('VALIDATION_ERROR');
      expect(toolError.category).toBe('validation');
      expect(toolError.message).toContain('failed to parse JSON');
    }
  });

  test('propagates not_found error from fetchFromPage on 404 status', async () => {
    try {
      await fetchJSON(`${baseUrl}/error-404`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('NOT_FOUND');
      expect(toolError.category).toBe('not_found');
    }
  });

  test('propagates timeout error from fetchFromPage', async () => {
    try {
      await fetchJSON(`${baseUrl}/slow`, { timeout: 100 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('TIMEOUT');
      expect(toolError.category).toBe('timeout');
    }
  });

  test('validates response against Zod schema when provided', async () => {
    const schema = z.object({ status: z.string() });
    const data = await fetchJSON(`${baseUrl}/ok`, undefined, schema);
    expect(data).toEqual({ status: 'success' });
  });

  test('throws ToolError.validation when response does not match schema', async () => {
    const schema = z.object({ count: z.number() });
    try {
      await fetchJSON(`${baseUrl}/ok`, undefined, schema);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('VALIDATION_ERROR');
      expect(toolError.category).toBe('validation');
      expect(toolError.message).toContain('failed schema validation');
    }
  });

  test('returns unchecked cast when schema is omitted (backward compat)', async () => {
    const data = await fetchJSON<{ status: string }>(`${baseUrl}/ok`);
    expect(data.status).toBe('success');
  });

  test('returns undefined for 204 response when no schema is provided', async () => {
    const data = await fetchJSON(`${baseUrl}/no-content`);
    expect(data).toBeUndefined();
  });

  test('throws ToolError.validation for 204 response when schema is provided', async () => {
    const schema = z.object({ status: z.string() });
    try {
      await fetchJSON(`${baseUrl}/no-content`, undefined, schema);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('VALIDATION_ERROR');
      expect(toolError.category).toBe('validation');
      expect(toolError.message).toContain('failed schema validation');
    }
  });
});

// ---------------------------------------------------------------------------
// postJSON
// ---------------------------------------------------------------------------

describe('postJSON', () => {
  test('sends POST request with JSON body and returns parsed response', async () => {
    const data = await postJSON<{ received: { name: string } }>(`${baseUrl}/echo-post`, {
      name: 'test',
    });
    expect(data).toEqual({ received: { name: 'test' } });
  });

  test('sets Content-Type to application/json', async () => {
    const data = await postJSON<{ received: unknown }>(`${baseUrl}/echo-post`, { key: 'value' });
    expect(data.received).toEqual({ key: 'value' });
  });

  test('allows additional headers via init', async () => {
    const data = await postJSON<{ received: unknown }>(
      `${baseUrl}/echo-post`,
      { data: 1 },
      { headers: { 'X-Custom': 'header' } },
    );
    expect(data.received).toEqual({ data: 1 });
  });

  test('propagates internal error on 500 status', async () => {
    try {
      await postJSON(`${baseUrl}/error-500`, { data: 'test' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('http_error');
      expect(toolError.category).toBe('internal');
    }
  });

  test('supports timeout option', async () => {
    try {
      await postJSON(`${baseUrl}/slow`, { data: 'test' }, { timeout: 100 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('TIMEOUT');
      expect(toolError.category).toBe('timeout');
    }
  });

  test('validates response against Zod schema when provided', async () => {
    const schema = z.object({ received: z.object({ name: z.string() }) });
    const data = await postJSON(`${baseUrl}/echo-post`, { name: 'test' }, undefined, schema);
    expect(data).toEqual({ received: { name: 'test' } });
  });

  test('throws ToolError.validation when response does not match schema', async () => {
    const schema = z.object({ received: z.object({ count: z.number() }) });
    try {
      await postJSON(`${baseUrl}/echo-post`, { name: 'test' }, undefined, schema);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.code).toBe('VALIDATION_ERROR');
      expect(toolError.category).toBe('validation');
      expect(toolError.message).toContain('failed schema validation');
    }
  });
});
