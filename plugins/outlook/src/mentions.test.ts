import { ToolError } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  composeWithMentions,
  findMentions,
  type MentionPerson,
  matchPerson,
  resolvePeople,
  unaddressedMentions,
} from './mentions.js';
import * as outlookApi from './outlook-api.js';

vi.mock('./outlook-api.js', () => ({
  api: vi.fn(),
  // Compose defaults are unavailable, so bodies come back as bare HTML without a font or signature.
  owsRequest: vi.fn(async () => {
    throw new Error('offline');
  }),
}));

const api = vi.mocked(outlookApi.api);

const JANE: MentionPerson = { name: 'Jane Doe', address: 'jane_doe@contoso.com' };
const JANET: MentionPerson = { name: 'Janet Smith', address: 'janet_smith@contoso.com' };
const RAVI: MentionPerson = { name: 'Ravi Kumar [C]', address: 'ravi_kumar@contoso.com' };
const PEOPLE = [JANE, JANET, RAVI];

const DIRECTORY: Record<string, string> = { 'pat@contoso.com': 'Pat Lee', 'jane_doe@contoso.com': 'Jane Doe' };

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async endpoint => {
    const address = decodeURIComponent(endpoint.replace('/users/', ''));
    const name = DIRECTORY[address];
    if (!name) throw ToolError.notFound('No such user');
    return { displayName: name } as never;
  });
});

/** The mention links in composed HTML, as [id, address, text]. */
const links = (html: string): [string, string, string][] =>
  [...html.matchAll(/<a id="([^"]+)" href="mailto:([^"]+)">([^<]+)<\/a>/g)].map(
    m => [m[1], m[2], m[3]] as [string, string, string],
  );

describe('findMentions', () => {
  test('finds every @[Name] in order, repeats included', () => {
    expect(findMentions('Hi @[Jane] and @[Ravi Kumar], thanks @[Jane]').map(m => m.target)).toEqual([
      'Jane',
      'Ravi Kumar',
      'Jane',
    ]);
  });

  test('separates the shown text from who an @[Text](who) mentions', () => {
    expect(findMentions('Hi @[Jane]( jane_doe@contoso.com ) and @[Ravi](Ravi Kumar)')).toEqual([
      { text: 'Jane', target: 'jane_doe@contoso.com' },
      { text: 'Ravi', target: 'Ravi Kumar' },
    ]);
  });

  test('ignores a bare @ and an email address', () => {
    expect(findMentions('mail jane@contoso.com @ noon')).toEqual([]);
  });
});

describe('matchPerson', () => {
  test('matches a whole name, an address, or a unique leading part', () => {
    expect(matchPerson('jane doe', PEOPLE)).toBe(JANE);
    expect(matchPerson('JANET_SMITH@contoso.com', PEOPLE)).toBe(JANET);
    expect(matchPerson('Janet', PEOPLE)).toBe(JANET);
    expect(matchPerson('Jane', PEOPLE)).toBe(JANE);
    expect(matchPerson('Rav', PEOPLE)).toBe(RAVI);
    expect(matchPerson('Jane D', PEOPLE)).toBe(JANE);
    expect(matchPerson('Ravi Kumar', PEOPLE)).toBe(RAVI);
  });

  test('refuses a name that matches several people, naming them', () => {
    expect(() => matchPerson('Jan', PEOPLE)).toThrow(/matches 2 people on this email: Jane Doe .*Janet Smith/);
  });

  test('refuses a name that matches no one, listing the people on the email', () => {
    expect(() => matchPerson('Bob', PEOPLE)).toThrow(/matches no one on this email \(people on it: Jane Doe/);
  });
});

describe('resolvePeople', () => {
  test('keeps recipient names, names bare addresses from the directory, and drops duplicates', async () => {
    const people = await resolvePeople([
      'pat@contoso.com',
      { emailAddress: { address: 'Ravi_Kumar@contoso.com', name: 'Ravi Kumar [C]' } },
      'ravi_kumar@contoso.com',
      'outside@example.org',
    ]);
    expect(people).toEqual([
      { name: 'Pat Lee', address: 'pat@contoso.com' },
      { name: 'Ravi Kumar [C]', address: 'Ravi_Kumar@contoso.com' },
      { name: 'outside@example.org', address: 'outside@example.org' },
    ]);
  });
});

describe('composeWithMentions', () => {
  test('turns each mention into an Outlook mention link with its own id', async () => {
    const { body, mentioned } = await composeWithMentions(
      { body: 'Hi @[Jane] & @[Ravi Kumar],\nsee above, @[Jane]' },
      'new',
      async () => PEOPLE,
    );
    const found = links(body.content);
    expect(found.map(([, address, text]) => [address, text])).toEqual([
      ['jane_doe@contoso.com', '@Jane'],
      ['ravi_kumar@contoso.com', '@Ravi Kumar'],
      ['jane_doe@contoso.com', '@Jane'],
    ]);
    for (const [id] of found) expect(id).toMatch(/^OWAAM[0-9A-F]{32}$/);
    expect(new Set(found.map(([id]) => id)).size).toBe(3);
    expect(body.content).toContain(' &amp; ');
    expect(body.content).toContain('<br>see above');
    expect(mentioned).toEqual([JANE, RAVI]);
  });

  test('renders mentions inside an HTML body', async () => {
    const { body } = await composeWithMentions(
      { body: '<p>Thanks <b>@[Janet]</b></p>', body_type: 'html' },
      'new',
      async () => PEOPLE,
    );
    expect(body.content).toMatch(
      /^<p>Thanks <b><a id="OWAAM[0-9A-F]{32}" href="mailto:janet_smith@contoso.com">@Janet<\/a><\/b><\/p>$/,
    );
  });

  test('shows the written first name for an @[Text](who) mention', async () => {
    const { body, mentioned } = await composeWithMentions(
      { body: 'Hi @[Jan](Janet Smith) and @[Pat](pat@contoso.com)' },
      'new',
      async () => PEOPLE,
    );
    expect(links(body.content).map(([, address, text]) => [address, text])).toEqual([
      ['janet_smith@contoso.com', '@Jan'],
      ['pat@contoso.com', '@Pat'],
    ]);
    expect(mentioned).toEqual([JANET, { name: 'Pat Lee', address: 'pat@contoso.com' }]);
  });

  test('names a person mentioned by email from the directory, without loading the email people', async () => {
    const loadPeople = vi.fn(async () => PEOPLE);
    const { body, mentioned } = await composeWithMentions({ body: 'cc @[pat@contoso.com]' }, 'new', loadPeople);
    expect(links(body.content).map(([, address, text]) => [address, text])).toEqual([['pat@contoso.com', '@Pat Lee']]);
    expect(mentioned).toEqual([{ name: 'Pat Lee', address: 'pat@contoso.com' }]);
    expect(loadPeople).not.toHaveBeenCalled();
  });

  test('leaves a body without mentions as composed', async () => {
    const loadPeople = vi.fn(async () => PEOPLE);
    const { body, mentioned } = await composeWithMentions({ body: 'email me @ work' }, 'new', loadPeople);
    expect(body.content).toBe('email me @ work');
    expect(mentioned).toEqual([]);
    expect(loadPeople).not.toHaveBeenCalled();
  });

  test('refuses a mention that matches no one on the email', async () => {
    await expect(composeWithMentions({ body: 'Hi @[Bob]' }, 'new', async () => PEOPLE)).rejects.toThrow(
      /@\[Bob\] matches no one/,
    );
  });
});

describe('unaddressedMentions', () => {
  test('returns the mentioned people on no recipient list, ignoring address case', () => {
    expect(
      unaddressedMentions(
        [JANE, RAVI, JANET],
        ['JANE_DOE@contoso.com', { emailAddress: { address: 'ravi_kumar@contoso.com' } }],
      ),
    ).toEqual([JANET]);
  });
});
