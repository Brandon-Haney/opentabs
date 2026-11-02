import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as outlookApi from '../outlook-api.js';
import { deleteEvent } from './delete-event.js';

vi.mock('../outlook-api.js', () => ({ api: vi.fn() }));

const api = vi.mocked(outlookApi.api);

const EVENT_PATH = '/me/events/AAMk-event';

const attendee = { emailAddress: { address: 'scott@contoso.com', name: 'Scott' }, type: 'required' };

/** Serve the mailbox time zone and the stored event, and accept every write. */
const serve = (event: Record<string, unknown>) => {
  api.mockImplementation(async (endpoint, options) => {
    if (endpoint === '/me/mailboxSettings') return { timeZone: 'Central Standard Time' };
    return options?.method ? {} : event;
  });
};

const meeting = (extra: Record<string, unknown>) => ({
  subject: 'Location Management in TAMS',
  start: { dateTime: '2026-11-03T09:30:00.0000000', timeZone: 'Central Standard Time' },
  end: { dateTime: '2026-11-03T10:00:00.0000000', timeZone: 'Central Standard Time' },
  ...extra,
});

const writes = () => api.mock.calls.filter(([, options]) => options?.method);

beforeEach(() => {
  api.mockReset();
});

describe('delete_event', () => {
  test('returns what it deleted, read in the mailbox time zone, and says the attendees were notified', async () => {
    serve(meeting({ isOrganizer: true, attendees: [attendee] }));

    const result = await deleteEvent.handle({ event_id: 'AAMk-event' });

    const read = api.mock.calls.find(([endpoint]) => endpoint === EVENT_PATH);
    expect(read?.[1]?.headers).toEqual({ Prefer: 'outlook.timezone="Central Standard Time"' });
    expect(writes()).toEqual([[EVENT_PATH, { method: 'DELETE' }, 'calendar-write']]);
    expect(result).toEqual({
      subject: 'Location Management in TAMS',
      start: { date_time: '2026-11-03T09:30:00.0000000', time_zone: 'Central Standard Time' },
      end: { date_time: '2026-11-03T10:00:00.0000000', time_zone: 'Central Standard Time' },
      attendees_notified: true,
    });
  });

  test('sends a cancellation with the note when the organizer passes one', async () => {
    serve(meeting({ isOrganizer: true, attendees: [attendee] }));

    await deleteEvent.handle({ event_id: 'AAMk-event', cancellation_message: 'Moving to Thursday' });

    expect(writes()).toEqual([
      [`${EVENT_PATH}/cancel`, { method: 'POST', body: { comment: 'Moving to Thursday' } }, 'calendar-write'],
    ]);
  });

  test('deletes an event with no attendees even when given a note, notifying no one', async () => {
    serve(meeting({ isOrganizer: true, attendees: [] }));

    const result = await deleteEvent.handle({ event_id: 'AAMk-event', cancellation_message: 'Not needed' });

    expect(writes()).toEqual([[EVENT_PATH, { method: 'DELETE' }, 'calendar-write']]);
    expect(result.attendees_notified).toBe(false);
  });

  test("removes someone else's meeting from the calendar without notifying anyone", async () => {
    serve(meeting({ isOrganizer: false, attendees: [attendee] }));

    const result = await deleteEvent.handle({ event_id: 'AAMk-event' });

    expect(writes()).toEqual([[EVENT_PATH, { method: 'DELETE' }, 'calendar-write']]);
    expect(result.attendees_notified).toBe(false);
  });

  test("refuses a cancellation note on someone else's meeting, without deleting it", async () => {
    serve(meeting({ isOrganizer: false, attendees: [attendee] }));

    await expect(
      deleteEvent.handle({ event_id: 'AAMk-event', cancellation_message: 'Cannot make it' }),
    ).rejects.toThrow('Only the organizer can send a cancellation');
    expect(writes()).toEqual([]);
  });
});
