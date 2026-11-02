import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { toUtcInstant } from '../local-time.js';
import { middleTierApi } from '../teams-api.js';
import { calendarEventSchema, mapCalendarEvent, type RawCalendarEvent } from './schemas.js';

const DEFAULT_LIMIT = 50;

/** A range bound as a UTC instant; a timestamp without an offset is read in local time. */
const toUtcBound = (label: string, timestamp: string): string => {
  const instant = toUtcInstant(timestamp);
  if (!instant) throw ToolError.validation(`The range ${label} "${timestamp}" is not an ISO 8601 date-time.`);
  return instant;
};

const rangeBound = (label: string, example: string) =>
  z
    .string()
    .datetime({ offset: true, local: true })
    .describe(`Range ${label} as ISO 8601 (e.g. "${example}"), read in local time unless it carries a UTC offset.`);

export const getCalendarView = defineTool({
  name: 'get_calendar_view',
  displayName: 'Get Calendar View',
  description:
    "Get the signed-in user's calendar events within a date/time range as Teams sees them, with recurring series expanded into individual occurrences. Each Teams meeting includes its join URL, dial-in details, and meeting_chat_id — the meeting chat's thread ID, usable directly with read_messages and send_message. Event IDs are Exchange IDs, shared with the Outlook plugin. Times are ISO 8601 in local time, with their UTC offset. Available on work or school Teams (teams.microsoft.com or teams.cloud.microsoft) only.",
  summary: 'List calendar events and Teams meetings in a range',
  icon: 'calendar',
  group: 'Calendar',
  input: z.object({
    start: rangeBound('start', '2026-06-02T00:00:00'),
    end: rangeBound('end', '2026-06-03T00:00:00'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(`Max events to return, earliest first (default ${DEFAULT_LIMIT}, max 200)`),
  }),
  output: z.object({
    events: z.array(calendarEventSchema).describe('Events overlapping the range, earliest start first'),
    total_count: z.number().int().describe('Events in the range before the limit was applied'),
  }),
  handle: async params => {
    const start = toUtcBound('start', params.start);
    const end = toUtcBound('end', params.end);
    if (Date.parse(start) >= Date.parse(end)) {
      throw ToolError.validation('The range start must be before its end.');
    }

    const data = await middleTierApi<{ value?: RawCalendarEvent[] }>('/beta/me/calendarEvents', {
      StartDate: start,
      EndDate: end,
    });

    const events = (data.value ?? []).map(mapCalendarEvent).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return {
      events: events.slice(0, params.limit ?? DEFAULT_LIMIT),
      total_count: events.length,
    };
  },
});
