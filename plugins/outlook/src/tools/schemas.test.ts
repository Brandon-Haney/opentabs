import { describe, expect, test } from 'vitest';
import { mapAttendee, mapCalendar, mapEventDetail, mapSchedule } from './calendar-schemas.js';
import { enumValue, mapMessageDetail, mapMessageSummary } from './schemas.js';

describe('enumValue', () => {
  test('uses Graph casing whichever API answered', () => {
    expect(enumValue('TentativelyAccepted', 'none')).toBe('tentativelyAccepted');
    expect(enumValue('tentativelyAccepted', 'none')).toBe('tentativelyAccepted');
  });

  test('falls back when the value is absent', () => {
    expect(enumValue(undefined, 'none')).toBe('none');
    expect(enumValue('', 'none')).toBe('none');
  });
});

describe('messages', () => {
  const restMessage = {
    importance: 'High',
    body: { contentType: 'HTML', content: '<p>hi</p>' },
    flag: { flagStatus: 'NotFlagged' },
    ccRecipients: [{ emailAddress: { name: 'Pat', address: 'pat@example.com' } }],
  };

  test('a message summary includes who was copied', () => {
    expect(mapMessageSummary(restMessage).cc).toEqual([{ name: 'Pat', address: 'pat@example.com' }]);
  });

  test('values from the Outlook REST fallback match the documented casing', () => {
    const message = mapMessageDetail(restMessage);
    expect(message.importance).toBe('high');
    expect(message.body_type).toBe('html');
    expect(message.flag_status).toBe('notFlagged');
  });
});

describe('events', () => {
  test('values from the Outlook REST fallback match the documented casing', () => {
    const event = mapEventDetail({
      showAs: 'WorkingElsewhere',
      type: 'SingleInstance',
      responseStatus: { response: 'TentativelyAccepted' },
      importance: 'Normal',
      sensitivity: 'Private',
      body: { contentType: 'Text', content: 'x' },
    });
    expect(event.show_as).toBe('workingElsewhere');
    expect(event.type).toBe('singleInstance');
    expect(event.response_status).toBe('tentativelyAccepted');
    expect(event.importance).toBe('normal');
    expect(event.sensitivity).toBe('private');
    expect(event.body_type).toBe('text');
  });

  test.each([
    'SeriesMaster',
    'Occurrence',
    'Exception',
    'seriesMaster',
    'occurrence',
    'exception',
  ])('an event of type %s is recurring', type => {
    expect(mapEventDetail({ type }).is_recurring).toBe(true);
  });

  test('a single event is not recurring', () => {
    expect(mapEventDetail({ type: 'SingleInstance' }).is_recurring).toBe(false);
  });

  test('attendees, calendars and schedules match the documented casing', () => {
    expect(mapAttendee({ type: 'Optional', status: { response: 'NotResponded' } })).toMatchObject({
      type: 'optional',
      response: 'notResponded',
    });
    expect(mapCalendar({ color: 'LightBlue' }).color).toBe('lightBlue');
    const schedule = mapSchedule({
      scheduleItems: [{ status: 'Busy' }],
      workingHours: { daysOfWeek: ['Monday'] },
    });
    expect(schedule.items[0]?.status).toBe('busy');
    expect(schedule.working_hours?.days_of_week).toEqual(['monday']);
  });
});
