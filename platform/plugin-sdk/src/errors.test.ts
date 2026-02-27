import { ToolError } from './errors.js';
import { describe, expect, test } from 'vitest';

describe('ToolError factory methods', () => {
  describe('default codes', () => {
    test('auth() uses AUTH_ERROR by default', () => {
      const err = ToolError.auth('unauthorized');
      expect(err.code).toBe('AUTH_ERROR');
      expect(err.category).toBe('auth');
      expect(err.retryable).toBe(false);
      expect(err.message).toBe('unauthorized');
    });

    test('notFound() uses NOT_FOUND by default', () => {
      const err = ToolError.notFound('missing');
      expect(err.code).toBe('NOT_FOUND');
      expect(err.category).toBe('not_found');
      expect(err.retryable).toBe(false);
    });

    test('rateLimited() uses RATE_LIMITED by default', () => {
      const err = ToolError.rateLimited('slow down');
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.category).toBe('rate_limit');
      expect(err.retryable).toBe(true);
    });

    test('validation() uses VALIDATION_ERROR by default', () => {
      const err = ToolError.validation('bad input');
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.category).toBe('validation');
      expect(err.retryable).toBe(false);
    });

    test('timeout() uses TIMEOUT by default', () => {
      const err = ToolError.timeout('too slow');
      expect(err.code).toBe('TIMEOUT');
      expect(err.category).toBe('timeout');
      expect(err.retryable).toBe(true);
    });

    test('internal() uses INTERNAL_ERROR by default', () => {
      const err = ToolError.internal('oops');
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.category).toBe('internal');
      expect(err.retryable).toBe(false);
    });
  });

  describe('custom codes', () => {
    test('auth() accepts custom code', () => {
      const err = ToolError.auth('token expired', 'TOKEN_EXPIRED');
      expect(err.code).toBe('TOKEN_EXPIRED');
      expect(err.category).toBe('auth');
      expect(err.retryable).toBe(false);
    });

    test('notFound() accepts custom code', () => {
      const err = ToolError.notFound('channel missing', 'CHANNEL_NOT_FOUND');
      expect(err.code).toBe('CHANNEL_NOT_FOUND');
      expect(err.category).toBe('not_found');
      expect(err.retryable).toBe(false);
    });

    test('rateLimited() accepts custom code', () => {
      const err = ToolError.rateLimited('too many requests', 5000, 'API_QUOTA_EXCEEDED');
      expect(err.code).toBe('API_QUOTA_EXCEEDED');
      expect(err.category).toBe('rate_limit');
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(5000);
    });

    test('validation() accepts custom code', () => {
      const err = ToolError.validation('invalid emoji', 'INVALID_EMOJI');
      expect(err.code).toBe('INVALID_EMOJI');
      expect(err.category).toBe('validation');
      expect(err.retryable).toBe(false);
    });

    test('timeout() accepts custom code', () => {
      const err = ToolError.timeout('search timed out', 'SEARCH_TIMEOUT');
      expect(err.code).toBe('SEARCH_TIMEOUT');
      expect(err.category).toBe('timeout');
      expect(err.retryable).toBe(true);
    });

    test('internal() accepts custom code', () => {
      const err = ToolError.internal('db connection failed', 'DB_CONNECTION_FAILED');
      expect(err.code).toBe('DB_CONNECTION_FAILED');
      expect(err.category).toBe('internal');
      expect(err.retryable).toBe(false);
    });
  });

  describe('rateLimited() retryAfterMs passthrough', () => {
    test('retryAfterMs is preserved with custom code', () => {
      const err = ToolError.rateLimited('wait', 3000, 'SLACK_RATE_LIMIT');
      expect(err.retryAfterMs).toBe(3000);
      expect(err.code).toBe('SLACK_RATE_LIMIT');
    });

    test('retryAfterMs defaults to undefined without value', () => {
      const err = ToolError.rateLimited('wait');
      expect(err.retryAfterMs).toBeUndefined();
      expect(err.code).toBe('RATE_LIMITED');
    });
  });
});
