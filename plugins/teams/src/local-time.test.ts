import { describe, expect, test } from 'vitest';
import { TEST_TIME_ZONE } from '../vitest.setup.js';
import { browserTimeZone, toLocalIso, toUtcInstant } from './local-time.js';

describe('toLocalIso', () => {
  test('writes a UTC time as the same instant in the browser zone, with its offset', () => {
    expect(browserTimeZone()).toBe(TEST_TIME_ZONE);
    expect(toLocalIso('2026-11-02T20:31:35Z')).toBe('2026-11-02T14:31:35-06:00');
    expect(toLocalIso('2026-09-25T15:00:00+00:00')).toBe('2026-09-25T10:00:00-05:00');
  });

  test('reads the seven fractional digits Teams writes, keeping milliseconds', () => {
    expect(toLocalIso('2026-11-02T15:28:05.7630000Z')).toBe('2026-11-02T09:28:05.763-06:00');
  });

  test('reads epoch milliseconds, as a number or as text', () => {
    expect(toLocalIso(1793378920468)).toBe('2026-10-30T11:48:40.468-05:00');
    expect(toLocalIso('1793378920468')).toBe('2026-10-30T11:48:40.468-05:00');
  });

  test('uses the offset in force at each instant, either side of the November change', () => {
    expect(toLocalIso('2026-11-01T06:30:00Z')).toBe('2026-11-01T01:30:00-05:00');
    expect(toLocalIso('2026-11-01T07:30:00Z')).toBe('2026-11-01T01:30:00-06:00');
  });

  test('writes the time in another zone when named', () => {
    expect(toLocalIso('2026-11-02T20:31:35Z', 'Asia/Kolkata')).toBe('2026-11-03T02:01:35+05:30');
  });

  test('keeps an empty value empty and returns one it cannot read unchanged', () => {
    expect(toLocalIso('')).toBe('');
    expect(toLocalIso(undefined)).toBe('');
    expect(toLocalIso('soon')).toBe('soon');
  });
});

describe('toUtcInstant', () => {
  test('keeps the instant of a value with an offset', () => {
    expect(toUtcInstant('2026-09-25T00:00:00-04:00')).toBe('2026-09-25T04:00:00.000Z');
    expect(toUtcInstant('2026-09-25T00:00:00Z')).toBe('2026-09-25T00:00:00.000Z');
  });

  test('reads a value without an offset in local time, on either side of a daylight-saving change', () => {
    expect(toUtcInstant('2026-11-03T09:00:00')).toBe('2026-11-03T15:00:00.000Z');
    expect(toUtcInstant('2026-07-01T09:00')).toBe('2026-07-01T14:00:00.000Z');
    expect(toUtcInstant('2026-03-08T12:00:00')).toBe('2026-03-08T17:00:00.000Z');
  });

  test('returns null for a value that is not a date-time', () => {
    expect(toUtcInstant('tomorrow')).toBeNull();
  });
});
