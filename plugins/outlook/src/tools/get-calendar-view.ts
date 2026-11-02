import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';
import { calendarTimeZone, timeZoneHeader, withZoneOffset } from '../time-zone.js';
import { EVENT_SUMMARY_FIELDS, eventSummarySchema, mapEventSummary, type RawEvent } from './calendar-schemas.js';

export const getCalendarView = defineTool({
  name: 'get_calendar_view',
  displayName: 'Get Calendar View',
  description:
    'Get the events occurring within a date/time range, with recurring series expanded into individual occurrences. This is the tool to answer "what is on my calendar" for a given day, week, or range. Times without a UTC offset, in the range and in the results, are in time_zone, which defaults to the mailbox time zone.',
  summary: 'View events in a date range',
  icon: 'calendar-clock',
  group: 'Calendar',
  input: z.object({
    start: z.iso
      .datetime({ offset: true, local: true })
      .describe(
        'Range start as ISO 8601 (e.g. "2026-06-02T00:00:00"), read in time_zone unless it carries a UTC offset.',
      ),
    end: z.iso
      .datetime({ offset: true, local: true })
      .describe(
        'Range end as ISO 8601 (e.g. "2026-06-09T00:00:00"), read in time_zone unless it carries a UTC offset.',
      ),
    calendar_id: z
      .string()
      .optional()
      .describe('Calendar ID to read (from list_calendars). Defaults to the primary calendar.'),
    limit: z.number().int().min(1).max(100).optional().describe('Max occurrences to return (default 50, max 100)'),
    time_zone: z
      .string()
      .optional()
      .describe(
        'Time zone for range bounds without an offset and for the returned event times, e.g. "Eastern Standard Time". Defaults to the mailbox time zone (Outlook\'s calendar setting).',
      ),
  }),
  output: z.object({
    events: z.array(eventSummarySchema).describe('Event occurrences within the range, ordered by start time'),
  }),
  handle: async params => {
    const zone = await calendarTimeZone(params.time_zone);
    const base = params.calendar_id ? `/me/calendars/${encodeURIComponent(params.calendar_id)}` : '/me';
    const data = await api<{ value: RawEvent[] }>(
      `${base}/calendarView`,
      {
        query: {
          startDateTime: withZoneOffset(params.start, zone),
          endDateTime: withZoneOffset(params.end, zone),
          $select: EVENT_SUMMARY_FIELDS,
          $orderby: 'start/dateTime',
          $top: params.limit ?? 50,
        },
        headers: timeZoneHeader(zone),
      },
      'calendar',
    );
    return { events: (data.value ?? []).map(mapEventSummary) };
  },
});
