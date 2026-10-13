import { describe, expect, test } from 'vitest';
import { findMentionNames, isEmailMention, matchPerson, renderMentions } from './chat-mentions.js';
import type { DirectoryUser } from './teams-api.js';

const person = (id: string, displayName: string, mail: string | null = null): DirectoryUser => ({
  id,
  displayName,
  mail,
  userPrincipalName: `${id}@contoso.com`,
});

const SANDIP = person('oid-sandip', 'Sandip Kumar', 'sandip_kumar@contoso.com');
const SANDRA = person('oid-sandra', 'Sandra Kim');
const RATNAKAR = person('oid-ratnakar', 'Ratnakar Bhide [C]');
const PEOPLE = [SANDIP, SANDRA, RATNAKAR];

describe('findMentionNames', () => {
  test('finds every @[Name] in order, repeats included', () => {
    expect(findMentionNames('Hi @[Sandip] and @[Sandra Kim], thanks @[Sandip]')).toEqual([
      'Sandip',
      'Sandra Kim',
      'Sandip',
    ]);
  });

  test('ignores an ordinary @ and a Markdown link', () => {
    expect(findMentionNames('email me @ work, see [docs](https://x.test)')).toEqual([]);
  });
});

describe('matchPerson', () => {
  test('matches a whole display name, an email, or a unique leading part', () => {
    expect(matchPerson('sandip kumar', PEOPLE)).toBe(SANDIP);
    expect(matchPerson('sandip_kumar@contoso.com', PEOPLE)).toBe(SANDIP);
    expect(matchPerson('Sandip', PEOPLE)).toBe(SANDIP);
    expect(matchPerson('Sandra K', PEOPLE)).toBe(SANDRA);
  });

  test('ignores a bracketed suffix on a display name', () => {
    expect(matchPerson('Ratnakar Bhide', PEOPLE)).toBe(RATNAKAR);
  });

  test('names the candidates when a name matches several people', () => {
    expect(() => matchPerson('San', PEOPLE)).toThrow(/matches 2 people.*Sandip Kumar.*Sandra Kim/);
  });

  test('lists the conversation when a name matches no one', () => {
    expect(() => matchPerson('Priya', PEOPLE)).toThrow(
      /matches no one.*Ratnakar Bhide \[C\], Sandip Kumar, Sandra Kim/,
    );
  });

  test('recognizes an email mention', () => {
    expect(isEmailMention('sandip_kumar@contoso.com')).toBe(true);
    expect(isEmailMention('Sandip')).toBe(false);
  });
});

describe('renderMentions', () => {
  test('turns each mention into a numbered span and lists it in the mentions property', () => {
    const { html, mentionsProperty } = renderMentions('**Hi** @[Sandip], see @[Sandra Kim]', name =>
      matchPerson(name, PEOPLE),
    );

    expect(html).toBe(
      '<p><strong>Hi</strong> <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Sandip</span>, ' +
        'see <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="1">Sandra Kim</span></p>',
    );
    expect(JSON.parse(mentionsProperty as string)).toEqual([
      {
        '@type': 'http://schema.skype.com/Mention',
        itemid: '0',
        mri: '8:orgid:oid-sandip',
        mentionType: 'person',
        displayName: 'Sandip Kumar',
      },
      {
        '@type': 'http://schema.skype.com/Mention',
        itemid: '1',
        mri: '8:orgid:oid-sandra',
        mentionType: 'person',
        displayName: 'Sandra Kim',
      },
    ]);
  });

  test('shows the display name for a mention written as an email', () => {
    const { html } = renderMentions('cc @[sandip_kumar@contoso.com]', name => matchPerson(name, PEOPLE));

    expect(html).toContain('itemid="0">Sandip Kumar</span>');
  });

  test('escapes the mention text', () => {
    const { html } = renderMentions('@[A<b>]', () => SANDIP);

    expect(html).toContain('itemid="0">A&lt;b&gt;</span>');
  });

  test('renders plain Markdown with no property when nothing is mentioned', () => {
    expect(renderMentions('plain *text*', () => SANDIP)).toEqual({
      html: '<p>plain <i>text</i></p>',
      mentionsProperty: null,
    });
  });
});
