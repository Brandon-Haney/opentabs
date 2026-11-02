import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { composeToolBody } from '../compose-defaults.js';
import { api } from '../outlook-api.js';
import { extractTeamsJoinDetails, linksTo } from '../teams-join-details.js';
import { calendarTimeZone, timeZoneHeader } from '../time-zone.js';
import {
  attendeeInputSchema,
  buildAttendees,
  buildDateTime,
  EVENT_DETAIL_FIELDS,
  eventDetailSchema,
  mapEventDetail,
  type RawEvent,
} from './calendar-schemas.js';

/**
 * Carry an online meeting's stored Teams join details over below a new body, so
 * the body update keeps the meeting and its join link. A body that already links
 * to the meeting, such as a full body read with get_event and edited, is kept as
 * it is.
 */
const withTeamsJoinDetails = async (eventId: string, content: string): Promise<string> => {
  const stored = await api<RawEvent>(
    `/me/events/${encodeURIComponent(eventId)}`,
    { query: { $select: 'isOnlineMeeting,onlineMeeting,body' } },
    'calendar',
  );
  if (!stored.isOnlineMeeting) return content;
  const joinUrl = stored.onlineMeeting?.joinUrl;
  if (joinUrl && linksTo(content, joinUrl)) return content;
  const details = extractTeamsJoinDetails(stored.body?.content ?? '');
  if (!details) {
    throw ToolError.validation(
      'This event is a Teams meeting, but its join details could not be found in its body, and a body without them ' +
        'would remove the Teams meeting. Read the body with get_event and pass it back in full with body_type "html", ' +
        'changing only the description above the join details.',
    );
  }
  return `${content}<br>${details}`;
};

export const updateEvent = defineTool({
  name: 'update_event',
  displayName: 'Update Event',
  description:
    "Update properties of an existing calendar event. Only the fields you provide are changed. Updating the attendees of a meeting you organize sends updated invitations. To change start/end times, provide both start and end. A new body is written as create_event writes one, in the user's default compose font. It replaces the description only: the Teams join details of an online meeting stay below it, because a body without them would remove the Teams meeting.",
  summary: 'Update a calendar event',
  icon: 'pencil',
  group: 'Calendar',
  input: z.object({
    event_id: z.string().describe('The event ID to update'),
    subject: z.string().optional().describe('New subject/title'),
    start: z.iso
      .datetime({ offset: false, local: true })
      .optional()
      .describe('New start as ISO 8601 without an offset; the zone is set by time_zone. Provide together with end.'),
    end: z.iso
      .datetime({ offset: false, local: true })
      .optional()
      .describe('New end as ISO 8601 without an offset; the zone is set by time_zone. Provide together with start.'),
    time_zone: z
      .string()
      .optional()
      .describe(
        'Time zone for start/end and the returned event (e.g. "Eastern Standard Time"). Defaults to the mailbox time zone (Outlook\'s calendar setting).',
      ),
    body: z
      .string()
      .optional()
      .describe("New event body/description. An online meeting's Teams join details are kept below it."),
    body_type: z.enum(['text', 'html']).optional().describe('Body content type (default: text)'),
    include_signature: z
      .boolean()
      .optional()
      .describe("Append the user's Outlook signature to the new body (default: false)"),
    location: z.string().optional().describe('New location display name'),
    attendees: z.array(attendeeInputSchema).optional().describe('Replace the attendee list'),
    is_all_day: z.boolean().optional().describe('Mark as all-day. When true, start/end must be at midnight.'),
    is_online_meeting: z.boolean().optional().describe('Toggle an online (Teams) meeting'),
    importance: z.enum(['low', 'normal', 'high']).optional().describe('Importance level'),
    show_as: z
      .enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere'])
      .optional()
      .describe('Free/busy status to show'),
    reminder_minutes_before_start: z.number().int().min(0).optional().describe('Reminder lead time in minutes'),
    categories: z.array(z.string()).optional().describe('Set categories/labels'),
  }),
  output: z.object({
    event: eventDetailSchema.describe('The updated event'),
  }),
  handle: async params => {
    const zone = await calendarTimeZone(params.time_zone);
    const body: Record<string, unknown> = {};
    if (params.subject !== undefined) body.subject = params.subject;
    if (params.start !== undefined) body.start = buildDateTime(params.start, zone);
    if (params.end !== undefined) body.end = buildDateTime(params.end, zone);
    if (params.body !== undefined) {
      const composed = await composeToolBody(
        { body: params.body, body_type: params.body_type, include_signature: params.include_signature ?? false },
        'new',
      );
      body.body = {
        contentType: composed.contentType,
        content:
          params.is_online_meeting === false
            ? composed.content
            : await withTeamsJoinDetails(params.event_id, composed.content),
      };
    }
    if (params.location !== undefined) body.location = { displayName: params.location };
    if (params.attendees !== undefined) body.attendees = buildAttendees(params.attendees);
    if (params.is_all_day !== undefined) body.isAllDay = params.is_all_day;
    if (params.is_online_meeting !== undefined) body.isOnlineMeeting = params.is_online_meeting;
    if (params.importance !== undefined) body.importance = params.importance;
    if (params.show_as !== undefined) body.showAs = params.show_as;
    if (params.reminder_minutes_before_start !== undefined) {
      body.reminderMinutesBeforeStart = params.reminder_minutes_before_start;
      body.isReminderOn = true;
    }
    if (params.categories !== undefined) body.categories = params.categories;

    if (Object.keys(body).length === 0) {
      throw ToolError.validation('Provide at least one field to update besides event_id.');
    }

    const updated = await api<RawEvent>(
      `/me/events/${encodeURIComponent(params.event_id)}`,
      { method: 'PATCH', body, query: { $select: EVENT_DETAIL_FIELDS }, headers: timeZoneHeader(zone) },
      'calendar-write',
    );
    return { event: mapEventDetail(updated) };
  },
});
