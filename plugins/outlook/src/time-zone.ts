import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './outlook-api.js';

/**
 * The time zone calendar tools read and write in when the caller names none: the
 * mailbox's own (Outlook settings > Calendar > Time zone), the zone Outlook shows
 * the user's calendar in. Mailbox settings give a Windows zone name such as
 * "Central Standard Time". When they cannot be read, the browser's IANA zone
 * stands in; Microsoft's calendar APIs accept both kinds of name.
 */

let mailboxTimeZone: string | null = null;

export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const readMailboxTimeZone = async (): Promise<string | null> => {
  try {
    const settings = await api<{ timeZone?: string }>(
      '/me/mailboxSettings',
      { query: { $select: 'timeZone' } },
      'settings',
    );
    return settings.timeZone?.trim() || null;
  } catch {
    return null;
  }
};

/** The zone to read and write calendar times in: the one requested, else the mailbox's, else the browser's. */
export const calendarTimeZone = async (requested?: string): Promise<string> => {
  if (requested) return requested;
  mailboxTimeZone ??= await readMailboxTimeZone();
  return mailboxTimeZone ?? browserTimeZone();
};

/** The `Prefer` header that makes Microsoft return event times in `zone`. */
export const timeZoneHeader = (zone: string): Record<string, string> => ({ Prefer: `outlook.timezone="${zone}"` });

const isValidIanaZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.includes('/') || zone === 'UTC';
  } catch {
    return false;
  }
};

/** The zone's names in the long English form Intl gives, at a winter and a summer date. */
const longNames = (ianaZone: string): string[] =>
  [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)].map(
    instant =>
      new Intl.DateTimeFormat('en-US', { timeZone: ianaZone, timeZoneName: 'long' })
        .formatToParts(instant)
        .find(part => part.type === 'timeZoneName')?.value ?? '',
  );

/**
 * The IANA zone a calendar zone name stands for, when that can be known: an IANA
 * name itself, or a Windows name matching what the browser calls its own zone
 * (Windows names the US and Canadian zones as Intl does, e.g. "Central Standard
 * Time" for America/Chicago). Null for any other Windows name.
 */
const ianaZoneFor = (zone: string): string | null => {
  if (isValidIanaZone(zone)) return zone;
  const browser = browserTimeZone();
  return longNames(browser).includes(zone) ? browser : null;
};

/** The zone's UTC offset in minutes at an instant. */
const offsetMinutesAt = (ianaZone: string, instant: number): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ianaZone,
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
  const wall = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return Math.round((wall - Math.floor(instant / 1000) * 1000) / 60_000);
};

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

const formatOffset = (minutes: number): string => {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

/**
 * Anchor a date-time to a zone: a value with an offset is returned as it is; a
 * local value is given the offset `zone` has at that wall-clock time. Throws when
 * the zone's offsets cannot be known in this browser, asking for an explicit one.
 */
export const withZoneOffset = (dateTime: string, zone: string): string => {
  if (HAS_OFFSET.test(dateTime)) return dateTime;
  const local = LOCAL_DATE_TIME.exec(dateTime);
  if (!local) throw ToolError.validation(`"${dateTime}" is not an ISO 8601 date-time.`);
  const ianaZone = ianaZoneFor(zone);
  if (!ianaZone) {
    throw ToolError.validation(
      `"${dateTime}" has no UTC offset, and the offsets of the time zone "${zone}" cannot be worked out here. ` +
        'Add the offset to the time (e.g. "2026-06-02T09:00:00-05:00").',
    );
  }
  const [year, month, day, hour, minute, second] = local.slice(1).map(part => Number(part ?? 0));
  const wall = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0);
  // The offset at the wall time read as UTC can differ from the offset at the real
  // instant across a daylight-saving change, so the second pass settles it.
  let offset = offsetMinutesAt(ianaZone, wall);
  offset = offsetMinutesAt(ianaZone, wall - offset * 60_000);
  return `${dateTime}${formatOffset(offset)}`;
};
