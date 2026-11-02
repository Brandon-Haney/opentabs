/**
 * Times the Teams tools return and accept, in the browser's time zone: the zone
 * the user's own clock and Teams show. Teams sends UTC (ISO 8601 or epoch
 * milliseconds); a returned time keeps its instant and carries the local UTC
 * offset, e.g. "2026-11-02T14:31:35-06:00", so it reads as the user sees it and
 * stays exact.
 */

export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const EPOCH_MS = /^\d{10,}$/;
/** Teams writes up to seven fractional digits, more than Date.parse reads reliably. */
const LONG_FRACTION = /(\.\d{3})\d+/;

const parseInstant = (timestamp: string): number => {
  if (EPOCH_MS.test(timestamp)) return Number(timestamp);
  return Date.parse(timestamp.replace(LONG_FRACTION, '$1'));
};

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

const formatOffset = (minutes: number): string => {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

/** The wall-clock fields of an instant in a zone, read as if they were UTC. */
const wallClockAt = (instant: number, timeZone: string): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map(part => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
};

/** The zone's UTC offset in minutes at an instant. */
const offsetMinutesAt = (instant: number, timeZone: string): number =>
  Math.round((wallClockAt(instant, timeZone) - Math.floor(instant / 1000) * 1000) / 60_000);

/**
 * A Teams timestamp as ISO 8601 in `timeZone` with its offset, keeping
 * milliseconds when the instant has them. An empty value stays empty, and one
 * that cannot be read is returned as it is.
 */
export const toLocalIso = (timestamp: string | number | null | undefined, timeZone = browserTimeZone()): string => {
  if (timestamp === null || timestamp === undefined || timestamp === '') return '';
  const instant = typeof timestamp === 'number' ? timestamp : parseInstant(timestamp);
  if (!Number.isFinite(instant)) return String(timestamp);
  const offset = offsetMinutesAt(instant, timeZone);
  const wall = new Date(instant + offset * 60_000);
  const millis = wall.getUTCMilliseconds();
  return (
    `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `${millis ? `.${pad(millis, 3)}` : ''}${formatOffset(offset)}`
  );
};

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A date-time as a UTC instant in ISO 8601: one with an offset as written, a local
 * one read in `timeZone`. Returns null for a value that is not a date-time.
 */
export const toUtcInstant = (dateTime: string, timeZone = browserTimeZone()): string | null => {
  if (HAS_OFFSET.test(dateTime)) {
    const instant = Date.parse(dateTime);
    return Number.isNaN(instant) ? null : new Date(instant).toISOString();
  }
  const wall = Date.parse(`${dateTime}Z`);
  if (Number.isNaN(wall)) return null;
  // The offset at the wall time read as UTC can differ from the offset at the real
  // instant across a daylight-saving change, so the second pass settles it.
  const firstOffset = offsetMinutesAt(wall, timeZone);
  const offset = offsetMinutesAt(wall - firstOffset * 60_000, timeZone);
  return new Date(wall - offset * 60_000).toISOString();
};
