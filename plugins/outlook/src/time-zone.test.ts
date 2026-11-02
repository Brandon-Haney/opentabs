import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as outlookApi from './outlook-api.js';

vi.mock('./outlook-api.js', () => ({ api: vi.fn() }));

const api = vi.mocked(outlookApi.api);

/** A fresh copy of the module, so the cached mailbox zone does not carry between tests. */
const load = async () => {
  vi.resetModules();
  return import('./time-zone.js');
};

/** Make the browser report `zone` as its own. */
const browserIn = (zone: string) => {
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolvedOptions.call(this), timeZone: zone };
  });
};

beforeEach(() => {
  api.mockReset();
  browserIn('America/Chicago');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('calendarTimeZone', () => {
  test('uses the zone the caller names without reading mailbox settings', async () => {
    const { calendarTimeZone } = await load();

    expect(await calendarTimeZone('Eastern Standard Time')).toBe('Eastern Standard Time');
    expect(api).not.toHaveBeenCalled();
  });

  test("defaults to the mailbox's zone, read once", async () => {
    api.mockResolvedValue({ timeZone: 'Central Standard Time' });
    const { calendarTimeZone } = await load();

    expect(await calendarTimeZone()).toBe('Central Standard Time');
    expect(await calendarTimeZone()).toBe('Central Standard Time');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/me/mailboxSettings', { query: { $select: 'timeZone' } }, 'settings');
  });

  test("falls back to the browser's zone when mailbox settings cannot be read, and asks again next time", async () => {
    api.mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce({ timeZone: 'Central Standard Time' });
    const { calendarTimeZone } = await load();

    expect(await calendarTimeZone()).toBe('America/Chicago');
    expect(await calendarTimeZone()).toBe('Central Standard Time');
  });
});

describe('withZoneOffset', () => {
  test('keeps a date-time that already carries an offset', async () => {
    const { withZoneOffset } = await load();

    expect(withZoneOffset('2026-11-03T09:00:00Z', 'Central Standard Time')).toBe('2026-11-03T09:00:00Z');
    expect(withZoneOffset('2026-11-03T09:00:00-05:00', 'Central Standard Time')).toBe('2026-11-03T09:00:00-05:00');
  });

  test('gives a local time the offset an IANA zone has then, on either side of a daylight-saving change', async () => {
    const { withZoneOffset } = await load();

    expect(withZoneOffset('2026-11-03T09:00:00', 'America/Chicago')).toBe('2026-11-03T09:00:00-06:00');
    expect(withZoneOffset('2026-07-01T09:00', 'America/Chicago')).toBe('2026-07-01T09:00-05:00');
    expect(withZoneOffset('2026-03-08T12:00:00', 'America/New_York')).toBe('2026-03-08T12:00:00-04:00');
    expect(withZoneOffset('2026-03-08T01:00:00', 'America/New_York')).toBe('2026-03-08T01:00:00-05:00');
    expect(withZoneOffset('2026-11-03T09:00:00', 'Asia/Kolkata')).toBe('2026-11-03T09:00:00+05:30');
  });

  test("reads a Windows zone name as the browser's zone when the browser gives its zone that name", async () => {
    const { withZoneOffset } = await load();

    expect(withZoneOffset('2026-11-03T09:00:00', 'Central Standard Time')).toBe('2026-11-03T09:00:00-06:00');
    expect(withZoneOffset('2026-07-01T09:00:00', 'Central Standard Time')).toBe('2026-07-01T09:00:00-05:00');
  });

  test('asks for an offset when a Windows zone name is not the browser zone', async () => {
    const { withZoneOffset } = await load();

    expect(() => withZoneOffset('2026-11-03T09:00:00', 'W. Europe Standard Time')).toThrow(
      'Add the offset to the time',
    );
  });
});
