import { colorTabState, formatUptime, isNonOpenTabsHttpError, isTimeout } from './status.js';
import { describe, expect, test } from 'vitest';

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  test('formats 0 seconds', () => {
    expect(formatUptime(0)).toBe('0s');
  });

  test('formats seconds below 60', () => {
    expect(formatUptime(30)).toBe('30s');
  });

  test('formats 59 seconds (boundary before minutes)', () => {
    expect(formatUptime(59)).toBe('59s');
  });

  test('formats exactly 60 seconds as minutes', () => {
    expect(formatUptime(60)).toBe('1m 0s');
  });

  test('formats 90 seconds as minutes + seconds', () => {
    expect(formatUptime(90)).toBe('1m 30s');
  });

  test('formats 3599 seconds (boundary before hours)', () => {
    expect(formatUptime(3599)).toBe('59m 59s');
  });

  test('formats exactly 3600 seconds as hours', () => {
    expect(formatUptime(3600)).toBe('1h 0m');
  });

  test('formats 7200 seconds as 2 hours', () => {
    expect(formatUptime(7200)).toBe('2h 0m');
  });

  test('formats 86399 seconds (boundary before days)', () => {
    expect(formatUptime(86399)).toBe('23h 59m');
  });

  test('formats exactly 86400 seconds as days', () => {
    expect(formatUptime(86400)).toBe('1d 0h');
  });

  test('formats multi-day values', () => {
    expect(formatUptime(172800)).toBe('2d 0h');
    expect(formatUptime(90061)).toBe('1d 1h');
  });

  test('truncates fractional seconds (123.456 → 2m 3s)', () => {
    expect(formatUptime(123.456)).toBe('2m 3s');
  });

  test('truncates fractional seconds below 1 (0.9 → 0s)', () => {
    expect(formatUptime(0.9)).toBe('0s');
  });

  test('truncates fractional seconds in hours range (3661.5 → 1h 1m)', () => {
    expect(formatUptime(3661.5)).toBe('1h 1m');
  });
});

// ---------------------------------------------------------------------------
// colorTabState
// ---------------------------------------------------------------------------

describe('colorTabState', () => {
  test('wraps "ready" in green', () => {
    const result = colorTabState('ready');
    expect(result).toContain('ready');
  });

  test('wraps "unavailable" in yellow', () => {
    const result = colorTabState('unavailable');
    expect(result).toContain('unavailable');
  });

  test('wraps "closed" in dim', () => {
    const result = colorTabState('closed');
    expect(result).toContain('closed');
  });

  test('wraps unknown string in dim', () => {
    const result = colorTabState('something-else');
    expect(result).toContain('something-else');
  });
});

// ---------------------------------------------------------------------------
// isTimeout
// ---------------------------------------------------------------------------

describe('isTimeout', () => {
  test('returns true for DOMException with name "TimeoutError"', () => {
    const err = new DOMException('The operation timed out', 'TimeoutError');
    expect(isTimeout(err)).toBe(true);
  });

  test('returns false for DOMException with different name', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(isTimeout(err)).toBe(false);
  });

  test('returns false for regular Error', () => {
    const err = new Error('timeout');
    expect(isTimeout(err)).toBe(false);
  });

  test('returns false for non-Error value', () => {
    expect(isTimeout('TimeoutError')).toBe(false);
    expect(isTimeout(null)).toBe(false);
    expect(isTimeout(undefined)).toBe(false);
    expect(isTimeout(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNonOpenTabsHttpError
// ---------------------------------------------------------------------------

describe('isNonOpenTabsHttpError', () => {
  test('returns true for 404 (not found — different service on port)', () => {
    expect(isNonOpenTabsHttpError(404, 'application/json')).toBe(true);
  });

  test('returns true for 403 (forbidden — 4xx non-401)', () => {
    expect(isNonOpenTabsHttpError(403, 'application/json')).toBe(true);
  });

  test('returns true for 400 (bad request)', () => {
    expect(isNonOpenTabsHttpError(400, 'application/json')).toBe(true);
  });

  test('returns false for 401 (authentication error — handled separately)', () => {
    expect(isNonOpenTabsHttpError(401, 'application/json')).toBe(false);
  });

  test('returns false for 500 with JSON content type (misconfigured OpenTabs server)', () => {
    expect(isNonOpenTabsHttpError(500, 'application/json')).toBe(false);
  });

  test('returns true for 500 with text/html content type (non-OpenTabs server)', () => {
    expect(isNonOpenTabsHttpError(500, 'text/html')).toBe(true);
  });

  test('returns true for 500 with text/html; charset=utf-8 content type', () => {
    expect(isNonOpenTabsHttpError(500, 'text/html; charset=utf-8')).toBe(true);
  });

  test('returns false for 500 with text/plain content type', () => {
    expect(isNonOpenTabsHttpError(500, 'text/plain')).toBe(false);
  });

  test('returns false for 500 with null content type', () => {
    expect(isNonOpenTabsHttpError(500, null)).toBe(false);
  });

  test('returns false for 502 with application/json content type', () => {
    expect(isNonOpenTabsHttpError(502, 'application/json; charset=utf-8')).toBe(false);
  });
});
