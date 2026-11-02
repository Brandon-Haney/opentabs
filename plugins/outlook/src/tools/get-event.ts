import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';
import { calendarTimeZone, timeZoneHeader } from '../time-zone.js';
import { EVENT_DETAIL_FIELDS, eventDetailSchema, mapEventDetail, type RawEvent } from './calendar-schemas.js';

export const getEvent = defineTool({
  name: 'get_event',
  displayName: 'Get Event',
  description:
    'Get the full details of a single calendar event, including body, attendees and their responses, location, reminders, and recurrence status.',
  summary: 'Get event details',
  icon: 'calendar',
  group: 'Calendar',
  input: z.object({
    event_id: z.string().describe('The event ID (from list_events or get_calendar_view)'),
    time_zone: z
      .string()
      .optional()
      .describe(
        'Time zone to return start/end times in (e.g. "Eastern Standard Time"). Defaults to the mailbox time zone (Outlook\'s calendar setting).',
      ),
  }),
  output: z.object({
    event: eventDetailSchema.describe('The event'),
  }),
  handle: async params => {
    const data = await api<RawEvent>(
      `/me/events/${encodeURIComponent(params.event_id)}`,
      {
        query: { $select: EVENT_DETAIL_FIELDS },
        headers: timeZoneHeader(await calendarTimeZone(params.time_zone)),
      },
      'calendar',
    );
    return { event: mapEventDetail(data) };
  },
});
