/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://teams.microsoft.com/v2/"}
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearCaches } from '../teams-api.js';
import { getCalendarView } from './get-calendar-view.js';
import type { RawCalendarEvent } from './schemas.js';

const MSAL_SKYPE_TOKEN = 'msal-skype-token';
const MIDDLE_TIER = 'https://teams.microsoft.com/api/mt/part/amer-03';

const stubCapturedToken = (): void => {
  vi.stubGlobal('__openTabs', {
    preScript: {
      teams: { enterpriseToken: { secret: MSAL_SKYPE_TOKEN, expiresOn: Math.floor(Date.now() / 1000) + 3600 } },
    },
  });
};

const storeRegionGtms = (): void => {
  localStorage.setItem(
    'tmp.Discover.SKYPE-TOKEN',
    JSON.stringify({ item: { regionGtms: { middleTier: MIDDLE_TIER } } }),
  );
};

const respondWith = (events: RawCalendarEvent[]): void => {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ type: 'Microsoft.SkypeSpaces.MiddleTier.Models.CalendarEvent', value: events }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
};

const teamsMeeting: RawCalendarEvent = {
  objectId: 'AQMkAD-meeting',
  subject: 'Weekly review',
  startTime: '2026-09-25T15:00:00+00:00',
  endTime: '2026-09-25T15:45:00+00:00',
  isAllDayEvent: false,
  location: 'Microsoft Teams Meeting',
  eventType: 'Exception',
  isOnlineMeeting: true,
  skypeTeamsMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
  skypeTeamsData: '{"cid":"19:meeting_abc@thread.v2","rid":0,"mid":0,"uid":null,"private":true}',
  onlineMeetingConferenceId: '944612810',
  onlineMeetingTollNumber: '+1 470-555-0100',
  organizerName: 'Organizer Name',
  isOrganizer: false,
  myResponseType: 'Accepted',
  showAs: 'Busy',
  isPrivate: false,
};

const lunch: RawCalendarEvent = {
  objectId: 'AQMkAD-lunch',
  subject: 'Lunch',
  startTime: '2026-09-25T16:00:00+00:00',
  endTime: '2026-09-25T17:00:00+00:00',
  eventType: null,
  isOnlineMeeting: false,
  myResponseType: 'Organizer',
  showAs: 'Tentative',
};

const earlyStandup: RawCalendarEvent = {
  objectId: 'AQMkAD-standup',
  subject: 'Standup',
  startTime: '2026-09-25T13:00:00+00:00',
  endTime: '2026-09-25T13:15:00+00:00',
  eventType: 'Occurrence',
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  clearCaches();
});

afterEach(() => {
  localStorage.clear();
  clearCaches();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('get_calendar_view', () => {
  test('requests the regional middle tier with UTC bounds and the MSAL token as a Bearer', async () => {
    stubCapturedToken();
    storeRegionGtms();
    respondWith([]);

    await getCalendarView.handle({ start: '2026-09-25T00:00:00-04:00', end: '2026-09-26T00:00:00' });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(`${MIDDLE_TIER}/beta/me/calendarEvents`);
    expect(url.searchParams.get('StartDate')).toBe('2026-09-25T04:00:00.000Z');
    // A bound without an offset is read as UTC.
    expect(url.searchParams.get('EndDate')).toBe('2026-09-26T00:00:00.000Z');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${MSAL_SKYPE_TOKEN}`);
  });

  test('maps Teams meeting details, including the meeting chat thread ID', async () => {
    stubCapturedToken();
    storeRegionGtms();
    respondWith([teamsMeeting]);

    const output = await getCalendarView.handle({ start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' });

    expect(getCalendarView.output.parse(output)).toEqual(output);
    expect(output.events[0]).toEqual({
      id: 'AQMkAD-meeting',
      subject: 'Weekly review',
      start: '2026-09-25T15:00:00.000Z',
      end: '2026-09-25T15:45:00.000Z',
      is_all_day: false,
      location: 'Microsoft Teams Meeting',
      type: 'Exception',
      is_online_meeting: true,
      join_url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
      meeting_chat_id: '19:meeting_abc@thread.v2',
      dial_in_conference_id: '944612810',
      dial_in_toll_number: '+1 470-555-0100',
      organizer_name: 'Organizer Name',
      is_organizer: false,
      response: 'Accepted',
      show_as: 'Busy',
      is_private: false,
    });
  });

  test('reports a non-recurring event as SingleInstance with empty meeting fields', async () => {
    stubCapturedToken();
    storeRegionGtms();
    respondWith([lunch]);

    const [event] = (await getCalendarView.handle({ start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }))
      .events;

    expect(event).toMatchObject({
      type: 'SingleInstance',
      join_url: '',
      meeting_chat_id: '',
      dial_in_conference_id: '',
    });
  });

  test('returns events earliest first and applies the limit after counting', async () => {
    stubCapturedToken();
    storeRegionGtms();
    respondWith([lunch, teamsMeeting, earlyStandup]);

    const output = await getCalendarView.handle({
      start: '2026-09-25T00:00:00Z',
      end: '2026-09-26T00:00:00Z',
      limit: 2,
    });

    expect(output.events.map(e => e.subject)).toEqual(['Standup', 'Weekly review']);
    expect(output.total_count).toBe(3);
  });

  test('rejects a range whose start is not before its end without a request', async () => {
    stubCapturedToken();
    storeRegionGtms();

    await expect(
      getCalendarView.handle({ start: '2026-09-26T00:00:00Z', end: '2026-09-25T00:00:00Z' }),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fails with an auth error when no MSAL Skype token was captured', async () => {
    vi.stubGlobal('__openTabs', { preScript: { teams: {} } });
    storeRegionGtms();

    await expect(
      getCalendarView.handle({ start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }),
    ).rejects.toMatchObject({ category: 'auth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fails with a reload hint when the region discovery data is missing', async () => {
    stubCapturedToken();

    await expect(
      getCalendarView.handle({ start: '2026-09-25T00:00:00Z', end: '2026-09-26T00:00:00Z' }),
    ).rejects.toThrow('Reload the Teams tab');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
