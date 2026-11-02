import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';
import { calendarTimeZone, timeZoneHeader } from '../time-zone.js';
import { dateTimeZoneSchema, mapDateTimeZone, type RawEvent } from './calendar-schemas.js';

interface StoredEvent extends RawEvent {
  isOrganizer?: boolean;
}

export const deleteEvent = defineTool({
  name: 'delete_event',
  displayName: 'Delete Event',
  description:
    'Delete or cancel a calendar event. Deleting a meeting you organize sends its attendees a cancellation; pass cancellation_message to include a note in it. Deleting a meeting someone else organizes removes it from your calendar only, without telling the organizer (use respond_to_event to decline instead). Returns the subject and times of the deleted event, in the mailbox time zone: compare them with the event you meant to delete.',
  summary: 'Delete or cancel an event',
  icon: 'calendar-x',
  group: 'Calendar',
  input: z.object({
    event_id: z.string().describe('The event ID to delete or cancel'),
    cancellation_message: z
      .string()
      .optional()
      .describe('Note to include in the cancellation sent to attendees. Only the organizer can send one.'),
  }),
  output: z.object({
    subject: z.string().describe('Subject of the deleted event'),
    start: dateTimeZoneSchema.describe('Start of the deleted event'),
    end: dateTimeZoneSchema.describe('End of the deleted event'),
    attendees_notified: z.boolean().describe('Whether its attendees were sent a cancellation'),
  }),
  handle: async params => {
    const eventPath = `/me/events/${encodeURIComponent(params.event_id)}`;
    const event = await api<StoredEvent>(
      eventPath,
      {
        query: { $select: 'subject,start,end,isOrganizer,attendees' },
        headers: timeZoneHeader(await calendarTimeZone()),
      },
      'calendar',
    );
    const attendeesNotified = event.isOrganizer === true && (event.attendees ?? []).length > 0;

    if (params.cancellation_message !== undefined && !event.isOrganizer) {
      throw ToolError.validation(
        'Only the organizer can send a cancellation. Delete the event without cancellation_message to remove it from your calendar, or decline it with respond_to_event.',
      );
    }
    if (params.cancellation_message !== undefined && attendeesNotified) {
      await api(
        `${eventPath}/cancel`,
        { method: 'POST', body: { comment: params.cancellation_message } },
        'calendar-write',
      );
    } else {
      await api(eventPath, { method: 'DELETE' }, 'calendar-write');
    }
    return {
      subject: event.subject ?? '',
      start: mapDateTimeZone(event.start),
      end: mapDateTimeZone(event.end),
      attendees_notified: attendeesNotified,
    };
  },
});
