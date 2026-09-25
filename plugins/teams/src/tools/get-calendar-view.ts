import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { middleTierApi } from '../teams-api.js';
import { calendarEventSchema, mapCalendarEvent, type RawCalendarEvent } from './schemas.js';

const DEFAULT_LIMIT = 50;

/** A range bound as UTC ISO 8601; a timestamp without an offset is read as UTC. */
const toUtcBound = (timestamp: string): string => {
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp);
  return new Date(hasOffset ? timestamp : `${timestamp}Z`).toISOString();
};

const rangeBound = (label: string, example: string) =>
  z
    .string()
    .datetime({ offset: true, local: true })
    .describe(
      `Range ${label} as ISO 8601. Include a UTC offset to anchor the zone (e.g. "${example}"); without an offset it is treated as UTC.`,
    );

export const getCalendarView = defineTool({
  name: 'get_calendar_view',
  displayName: 'Get Calendar View',
  description:
    "Get the signed-in user's calendar events within a date/time range as Teams sees them, with recurring series expanded into individual occurrences. Each Teams meeting includes its join URL, dial-in details, and meeting_chat_id — the meeting chat's thread ID, usable directly with read_messages and send_message. Event IDs are Exchange IDs, shared with the Outlook plugin. Returned times are UTC. Available on work or school Teams (teams.microsoft.com or teams.cloud.microsoft) only.",
  summary: 'List calendar events and Teams meetings in a range',
  icon: 'calendar',
  group: 'Calendar',
  input: z.object({
    start: rangeBound('start', '2026-06-02T00:00:00-04:00'),
    end: rangeBound('end', '2026-06-03T00:00:00-04:00'),
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
    const start = toUtcBound(params.start);
    const end = toUtcBound(params.end);
    if (Date.parse(start) >= Date.parse(end)) {
      throw ToolError.validation('The range start must be before its end.');
    }

    const data = await middleTierApi<{ value?: RawCalendarEvent[] }>('/beta/me/calendarEvents', {
      StartDate: start,
      EndDate: end,
    });

    const events = (data.value ?? []).map(mapCalendarEvent).sort((a, b) => a.start.localeCompare(b.start));
    return {
      events: events.slice(0, params.limit ?? DEFAULT_LIMIT),
      total_count: events.length,
    };
  },
});
