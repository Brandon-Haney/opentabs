import type { AuditEntry } from '@opentabs-dev/shared';
import { InvalidArgumentError } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { formatDuration, formatTimestamp, parseDuration, parseLimit, printAuditTable } from './audit.js';

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  test('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  test('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  test('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  test('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  test('returns null for alphabetic input', () => {
    expect(parseDuration('abc')).toBeNull();
  });

  test('returns null for unknown unit', () => {
    expect(parseDuration('30x')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseDuration('')).toBeNull();
  });

  test('returns null for negative values (no leading sign support)', () => {
    expect(parseDuration('-30s')).toBeNull();
  });

  test('returns null for bare number without unit', () => {
    expect(parseDuration('100')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('same day — shows HH:MM:SS only', () => {
    vi.useFakeTimers();
    // Set "now" to noon local time today
    const now = new Date(2024, 5, 15, 12, 0, 0);
    vi.setSystemTime(now);

    // Timestamp from earlier the same local day
    const earlier = new Date(2024, 5, 15, 9, 30, 45);
    const result = formatTimestamp(earlier.toISOString());
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('different day — shows MM-DD HH:MM:SS', () => {
    vi.useFakeTimers();
    const now = new Date(2024, 5, 15, 12, 0, 0);
    vi.setSystemTime(now);

    // Timestamp from the previous local day
    const yesterday = new Date(2024, 5, 14, 9, 30, 45);
    const result = formatTimestamp(yesterday.toISOString());
    expect(result).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('midnight boundary — previous day shows date prefix', () => {
    vi.useFakeTimers();
    // "now" is just after local midnight on the 15th
    const now = new Date(2024, 5, 15, 0, 1, 0);
    vi.setSystemTime(now);

    // Timestamp from the 14th just before local midnight
    const beforeMidnight = new Date(2024, 5, 14, 23, 59, 0);
    const result = formatTimestamp(beforeMidnight.toISOString());
    expect(result).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('same day — time values are zero-padded', () => {
    vi.useFakeTimers();
    const now = new Date(2024, 0, 5, 12, 0, 0);
    vi.setSystemTime(now);

    // 03:04:05 local time on the same day
    const early = new Date(2024, 0, 5, 3, 4, 5);
    const result = formatTimestamp(early.toISOString());
    // All three components should be two digits
    const parts = result.split(':');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^\d{2}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('sub-second shows ms', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  test('zero milliseconds shows 0ms', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  test('999ms shows ms (boundary before seconds)', () => {
    expect(formatDuration(999)).toBe('999ms');
  });

  test('exactly 1000ms shows 1.0s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
  });

  test('1500ms shows 1.5s', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  test('10000ms shows 10.0s', () => {
    expect(formatDuration(10_000)).toBe('10.0s');
  });
});

// ---------------------------------------------------------------------------
// parseLimit
// ---------------------------------------------------------------------------

describe('parseLimit', () => {
  test('parses a valid positive integer', () => {
    expect(parseLimit('10')).toBe(10);
  });

  test('parses 1 (minimum valid value)', () => {
    expect(parseLimit('1')).toBe(1);
  });

  test('parses large numbers', () => {
    expect(parseLimit('1000')).toBe(1000);
  });

  test('throws for 0', () => {
    expect(() => parseLimit('0')).toThrow(InvalidArgumentError);
  });

  test('throws for negative integers', () => {
    expect(() => parseLimit('-5')).toThrow(InvalidArgumentError);
  });

  test('throws for non-integer floats', () => {
    expect(() => parseLimit('1.5')).toThrow(InvalidArgumentError);
  });

  test('throws for non-numeric strings', () => {
    expect(() => parseLimit('abc')).toThrow(InvalidArgumentError);
  });

  test('throws for empty string', () => {
    expect(() => parseLimit('')).toThrow(InvalidArgumentError);
  });
});

// ---------------------------------------------------------------------------
// printAuditTable
// ---------------------------------------------------------------------------

/** Width of the fixed Time column (mirrors COL_TIME in audit.ts) */
const TIME_WIDTH = 15;

/** Remove ANSI color sequences so column positions can be asserted on plain text */
const ANSI_ESCAPE = String.fromCharCode(27);
const stripAnsi = (line: string): string => line.replace(new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g'), '');

const makeEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  timestamp: '2026-02-21T12:00:00.000Z',
  tool: 'outlook__list_messages',
  plugin: 'outlook',
  success: true,
  durationMs: 120,
  ...overrides,
});

/** Capture the plain-text lines printAuditTable writes to console.log */
const renderTable = (entries: AuditEntry[]): string[] => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    printAuditTable(entries);
    return spy.mock.calls.map(call => stripAnsi(String(call[0])));
  } finally {
    spy.mockRestore();
  }
};

describe('printAuditTable', () => {
  test('header places an Origin column between Tool and the status column', () => {
    const [header] = renderTable([makeEntry()]);
    expect(header).toMatch(/^Time\s+Tool\s+Origin\s+Duration\s*$/);
  });

  test('row prints tabOrigin verbatim between tool and status', () => {
    const origin = 'https://outlook.office.com';
    const lines = renderTable([makeEntry({ tabOrigin: origin })]);
    const row = lines[2];
    if (row === undefined) throw new Error('Expected a data row');

    const toolColumnWidth = 'outlook__list_messages'.length + 2;
    const originColumnWidth = origin.length + 2;
    expect(row.indexOf('outlook__list_messages')).toBe(TIME_WIDTH);
    expect(row.indexOf(origin)).toBe(TIME_WIDTH + toolColumnWidth);
    expect(row.indexOf('✓')).toBe(TIME_WIDTH + toolColumnWidth + originColumnWidth);
    expect(row).toContain(`${origin}  ✓`);
  });

  test('entries without tabOrigin render a blank origin cell and stay aligned with entries that have one', () => {
    const origin = 'https://outlook.office.com';
    const lines = renderTable([makeEntry({ tabOrigin: origin }), makeEntry({ success: false, durationMs: 2500 })]);
    const [, , withOrigin, withoutOrigin] = lines;
    if (withOrigin === undefined || withoutOrigin === undefined) throw new Error('Expected two data rows');

    expect(withoutOrigin).not.toContain(origin);
    expect(withOrigin.indexOf('✓')).toBe(withoutOrigin.indexOf('✗'));
    expect(withoutOrigin.indexOf('2.5s')).toBe(withOrigin.indexOf('120ms'));
  });

  test('origin column width grows to the longest origin', () => {
    const shortOrigin = 'https://a.io';
    const longOrigin = 'https://contoso-my.sharepoint.com';
    const lines = renderTable([makeEntry({ tabOrigin: shortOrigin }), makeEntry({ tabOrigin: longOrigin })]);
    const [header, , shortRow, longRow] = lines;
    if (header === undefined || shortRow === undefined || longRow === undefined) {
      throw new Error('Expected header and two data rows');
    }

    const toolColumnWidth = 'outlook__list_messages'.length + 2;
    const originColumnWidth = longOrigin.length + 2;
    const statusIndex = TIME_WIDTH + toolColumnWidth + originColumnWidth;
    expect(shortRow.indexOf('✓')).toBe(statusIndex);
    expect(longRow.indexOf('✓')).toBe(statusIndex);
    expect(header.indexOf('Duration')).toBe(statusIndex + 4);
  });

  test('origin column keeps its minimum width when no entry carries an origin', () => {
    const [header, , row] = renderTable([makeEntry()]);
    if (header === undefined || row === undefined) throw new Error('Expected header and a data row');

    const toolColumnWidth = 'outlook__list_messages'.length + 2;
    const originColumnWidth = 'Origin'.length + 2;
    expect(header.indexOf('Origin')).toBe(TIME_WIDTH + toolColumnWidth);
    expect(row.indexOf('✓')).toBe(TIME_WIDTH + toolColumnWidth + originColumnWidth);
  });
});
