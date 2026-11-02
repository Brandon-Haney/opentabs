import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as outlookApi from '../outlook-api.js';
import { createEvent } from './create-event.js';
import { updateEvent } from './update-event.js';

vi.mock('../outlook-api.js', () => ({ api: vi.fn(), owsRequest: vi.fn() }));

const api = vi.mocked(outlookApi.api);
const owsRequest = vi.mocked(outlookApi.owsRequest);

const EVENT_ID = 'AAMk-event';
const JOIN_URL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d';
const DETAILS =
  '<div class="me-email-text">Microsoft Teams meeting ' +
  '<a href="https://teams.microsoft.com/meet/1?p=a" id="meet_invite_block.action.join_link">Join</a> ' +
  `<a href="${JOIN_URL}">System reference</a></div>`;
const FONT =
  '<div style="font-family: Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif; font-size: 12pt; color: #000000">';

/** Serve the mailbox time zone and the stored event to GETs, and echo a write's body back as the saved event. */
const serve = (stored: Record<string, unknown>) => {
  api.mockImplementation(async (endpoint, options) => {
    if (endpoint === '/me/mailboxSettings') return { timeZone: 'Central Standard Time' };
    return options?.method ? { id: EVENT_ID, ...(options.body as Record<string, unknown>) } : stored;
  });
};

const eventReads = () =>
  api.mock.calls.filter(([endpoint, options]) => endpoint.startsWith('/me/events/') && !options?.method);

const onlineMeeting = (body: string) => ({
  isOnlineMeeting: true,
  onlineMeeting: { joinUrl: JOIN_URL },
  body: { contentType: 'html', content: `<html><body><div>Old agenda</div><br>${body}</body></html>` },
});

const writeCall = () => api.mock.calls.find(([, options]) => options?.method);
const writtenBody = () => (writeCall()?.[1]?.body as { body?: { contentType: string; content: string } }).body;

beforeEach(() => {
  api.mockReset();
  owsRequest.mockReset();
  // The user has a signature set for new messages; event bodies carry it only on request.
  owsRequest.mockImplementation(async (path, options) => {
    if (options?.headers?.['x-islargesetting']) return [{ secondaryKey: 'htm', value: '<p>Signature</p>' }];
    if (path.includes('startupdata')) return {};
    return [{ name: 'roaming_new_signature', value: 'Work' }];
  });
});

describe('create_event', () => {
  test('writes a plain-text body as HTML in the default compose font, without a signature', async () => {
    serve({});

    await createEvent.handle({
      subject: 'Locators',
      start: '2026-11-03T09:30:00',
      end: '2026-11-03T10:00:00',
      body: 'Agenda:\nLocators & bins',
      is_online_meeting: true,
    });

    expect(writtenBody()).toEqual({ contentType: 'HTML', content: `${FONT}Agenda:<br>Locators &amp; bins</div>` });
  });

  test('adds the signature when include_signature is true', async () => {
    serve({});

    await createEvent.handle({
      subject: 'Locators',
      start: '2026-11-03T09:30:00',
      end: '2026-11-03T10:00:00',
      body: 'Agenda',
      include_signature: true,
    });

    expect(writtenBody()?.content).toBe(`${FONT}Agenda</div><br><p>Signature</p>`);
  });

  test('refuses a plain-text body written in HTML, before creating anything', async () => {
    serve({});

    await expect(
      createEvent.handle({
        subject: 'Locators',
        start: '2026-11-03T09:30:00',
        end: '2026-11-03T10:00:00',
        body: '<p>Agenda</p>',
      }),
    ).rejects.toThrow('body_type to "html"');
    expect(writeCall()).toBeUndefined();
  });
});

describe('update_event', () => {
  test("keeps an online meeting's Teams join details below the new body", async () => {
    serve(onlineMeeting(DETAILS));

    await updateEvent.handle({ event_id: EVENT_ID, body: 'New agenda' });

    expect(eventReads()[0]?.[1]?.query).toEqual({ $select: 'isOnlineMeeting,onlineMeeting,body' });
    expect(writtenBody()).toEqual({ contentType: 'HTML', content: `${FONT}New agenda</div><br>${DETAILS}` });
  });

  test('keeps a full body that already links to the meeting as it is', async () => {
    serve(onlineMeeting(DETAILS));
    const full = `<div>Edited agenda</div><br>${DETAILS}`;

    await updateEvent.handle({ event_id: EVENT_ID, body: full, body_type: 'html' });

    expect(writtenBody()?.content).toBe(full);
  });

  test('writes only the new body on an event without a Teams meeting', async () => {
    serve({ isOnlineMeeting: false, body: { content: '<html><body>Old</body></html>' } });

    await updateEvent.handle({ event_id: EVENT_ID, body: 'New agenda' });

    expect(writtenBody()?.content).toBe(`${FONT}New agenda</div>`);
  });

  test('leaves the stored body alone when the update also turns the Teams meeting off', async () => {
    serve(onlineMeeting(DETAILS));

    await updateEvent.handle({ event_id: EVENT_ID, body: 'New agenda', is_online_meeting: false });

    expect(eventReads()).toHaveLength(0);
    expect(writtenBody()?.content).toBe(`${FONT}New agenda</div>`);
  });

  test('refuses a body edit when the join details cannot be found, without changing the event', async () => {
    serve(onlineMeeting('<p>Join with the link in the location</p>'));

    await expect(updateEvent.handle({ event_id: EVENT_ID, body: 'New agenda' })).rejects.toThrow(
      'would remove the Teams meeting',
    );
    expect(writeCall()).toBeUndefined();
  });
});
