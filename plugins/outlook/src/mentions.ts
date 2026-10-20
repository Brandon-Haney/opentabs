import { ToolError } from '@opentabs-dev/plugin-sdk';
import { type ComposedBody, composeToolBody, escapeHtml } from './compose-defaults.js';
import { api } from './outlook-api.js';
import type { RawEmailAddress } from './tools/schemas.js';

/**
 * @mentions in a composed email.
 *
 * Outlook marks a mention in the message HTML as a mailto link whose id starts
 * with `OWAAM`:
 *
 *   <a id="OWAAM480476CE0974458A8043550D5CAF46AE" href="mailto:jane@contoso.com">@Jane Doe</a>
 *
 * Exchange reads those links when the message is sent, which is what flags the
 * message as mentioning that person in their mailbox. Outlook on the web also
 * adds a mentioned person to the To line when they are not already a recipient.
 *
 * Callers write a mention as `@[Name]` in the body. The name is matched against
 * the people on the email; `@[someone@example.com]` names a person directly by
 * email, for someone not yet on it. The link shows the text written, the way
 * Outlook lets a sender trim a mention back to a first name; `@[Text](who)`
 * shows Text and mentions the person `who` names (a name or email), for a first
 * name that alone matches several people.
 */

/** `@[Name]` or `@[Text](who)` — no brackets, parentheses or line breaks inside either part. */
const MENTION_PATTERN = /@\[([^\][\r\n]+)\](?:\(([^()\r\n]+)\))?/g;

/** A person a mention can name. */
export interface MentionPerson {
  name: string;
  address: string;
}

/** One `@[...]` in a body: the text it shows, and the name or email of who it mentions. */
export interface WrittenMention {
  text: string;
  target: string;
}

const writtenMention = (rawText: string, rawTarget: string | undefined): WrittenMention | null => {
  const text = rawText.trim();
  const target = rawTarget?.trim() || text;
  return text.length > 0 ? { text, target } : null;
};

/** Every `@[...]` in a body, in order, repeats included. */
export const findMentions = (body: string): WrittenMention[] =>
  [...body.matchAll(MENTION_PATTERN)].flatMap(match => writtenMention(match[1] ?? '', match[2]) ?? []);

/** Whether a mention names its person by email address. */
export const isEmailMention = (name: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name);

const normalize = (value: string): string => value.trim().toLowerCase();

/** The words of a display name, ignoring decorations such as "[C]". */
const nameWords = (displayName: string): string[] =>
  normalize(displayName)
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);

/**
 * The one person a mention name identifies among `people`: an exact display
 * name or address match first, then the person whose name contains every word
 * of the mention ("Jane" for "Jane Doe" even beside "Janet Smith"), otherwise
 * the person whose name contains every word as the start of one of its words
 * ("Jan" or "Jane D" for "Jane Doe"). Throws a validation error naming the candidates when the name
 * matches several people, and the email's people when it matches none, so the
 * caller can correct it instead of sending a dead mention.
 */
export const matchPerson = (name: string, people: MentionPerson[]): MentionPerson => {
  const wanted = normalize(name);
  const exact = people.filter(p => normalize(p.name) === wanted || normalize(p.address) === wanted);
  if (exact.length === 1) return exact[0] as MentionPerson;

  const queryWords = nameWords(name);
  const matchingEvery = (fits: (word: string, query: string) => boolean): MentionPerson[] =>
    people.filter(p => {
      const words = nameWords(p.name);
      return queryWords.length > 0 && queryWords.every(q => words.some(w => fits(w, q)));
    });
  const wholeWords = exact.length > 1 ? exact : matchingEvery((word, query) => word === query);
  const partial = wholeWords.length > 0 ? wholeWords : matchingEvery((word, query) => word.startsWith(query));
  const [only, ...rest] = partial;
  if (only && rest.length === 0) return only;

  if (partial.length > 1) {
    throw ToolError.validation(
      `@[${name}] matches ${partial.length} people on this email: ${partial
        .slice(0, 8)
        .map(p => `${p.name} (${p.address})`)
        .join('; ')}. Use more of the name, or their email: @[name@example.com].`,
    );
  }
  const known = people.map(p => p.name).sort();
  throw ToolError.validation(
    `@[${name}] matches no one on this email` +
      (known.length > 0 ? ` (people on it: ${known.slice(0, 25).join(', ')}${known.length > 25 ? ', …' : ''})` : '') +
      '. Check the spelling, or name them by email: @[name@example.com].',
  );
};

/** A person's display name from the directory, or their address when the directory does not know them. */
const lookUpPerson = async (address: string): Promise<MentionPerson> => {
  try {
    const user = await api<{ displayName?: string }>(`/users/${encodeURIComponent(address)}`, {
      query: { $select: 'displayName' },
    });
    return { name: user.displayName || address, address };
  } catch {
    return { name: address, address };
  }
};

/**
 * The distinct people among message recipients, by address. A recipient given
 * as a bare address (as the compose tools take them) is named from the directory.
 */
export const resolvePeople = async (recipients: readonly (string | RawEmailAddress)[]): Promise<MentionPerson[]> => {
  const byAddress = new Map<string, { address: string; name?: string }>();
  for (const recipient of recipients) {
    const address = typeof recipient === 'string' ? recipient : recipient.emailAddress?.address;
    if (!address) continue;
    const name = typeof recipient === 'string' ? undefined : recipient.emailAddress?.name;
    const known = byAddress.get(normalize(address));
    if (!known?.name) byAddress.set(normalize(address), { address, name: name || undefined });
  }
  return Promise.all(
    [...byAddress.values()].map(entry =>
      entry.name ? { name: entry.name, address: entry.address } : lookUpPerson(entry.address),
    ),
  );
};

/** The sender and To/CC recipients of an existing message, the people a reply or forward to it can mention. */
export const threadRecipients = async (messageId: string): Promise<RawEmailAddress[]> => {
  const message = await api<{
    from?: RawEmailAddress;
    toRecipients?: RawEmailAddress[];
    ccRecipients?: RawEmailAddress[];
  }>(`/me/messages/${messageId}`, { query: { $select: 'from,toRecipients,ccRecipients' } });
  return [...(message.from ? [message.from] : []), ...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])];
};

/** The id Outlook gives a mention link: `OWAAM` and 32 uppercase hex digits. */
const mentionId = (): string => `OWAAM${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;

/** A body composed with its mentions rendered, and the people it mentions. */
export interface MentionedBody {
  body: ComposedBody;
  /** Each mentioned person once, in order of first mention. */
  mentioned: MentionPerson[];
}

/**
 * Compose a body (default font and signature applied, as `composeToolBody` does)
 * with its `@[...]` mentions turned into Outlook mention links.
 *
 * `loadPeople` supplies the people on the email and is called only when the body
 * mentions someone by name. A mention by email address that matches none of them
 * is named from the directory. A bare `@[email]` shows the person's display name;
 * any other mention shows the text the caller wrote.
 */
export const composeWithMentions = async (
  input: { body: string; body_type?: 'text' | 'html'; include_signature?: boolean },
  signatureKind: Parameters<typeof composeToolBody>[1],
  loadPeople: () => Promise<MentionPerson[]>,
): Promise<MentionedBody> => {
  const targets = findMentions(input.body).map(mention => mention.target);
  if (targets.length === 0) return { body: await composeToolBody(input, signatureKind), mentioned: [] };

  const people = targets.some(target => !isEmailMention(target)) ? await loadPeople() : [];
  const resolved = new Map<string, MentionPerson>();
  for (const target of new Set(targets)) {
    const onEmail = isEmailMention(target)
      ? people.find(p => normalize(p.address) === normalize(target))
      : matchPerson(target, people);
    resolved.set(target, onEmail ?? (await lookUpPerson(target)));
  }

  // Letters and digits only, so neither text escaping nor the HTML wrapper alters them.
  const placeholder = (index: number): string => `OTBMENTION${index}X`;
  const links: string[] = [];
  const withPlaceholders = input.body.replace(MENTION_PATTERN, (whole, rawText: string, rawTarget?: string) => {
    const written = writtenMention(rawText, rawTarget);
    const person = written && resolved.get(written.target);
    if (!written || !person) return whole;
    const text = rawTarget === undefined && isEmailMention(written.text) ? person.name : written.text;
    links.push(`<a id="${mentionId()}" href="mailto:${escapeHtml(person.address)}">@${escapeHtml(text)}</a>`);
    return placeholder(links.length - 1);
  });

  const composed = await composeToolBody({ ...input, body: withPlaceholders }, signatureKind);
  const content = links.reduce((html, link, index) => html.replace(placeholder(index), link), composed.content);

  const mentioned = new Map<string, MentionPerson>();
  for (const target of targets) {
    const person = resolved.get(target) as MentionPerson;
    if (!mentioned.has(normalize(person.address))) mentioned.set(normalize(person.address), person);
  }
  return { body: { ...composed, content }, mentioned: [...mentioned.values()] };
};

/**
 * The mentioned people who are on none of the given recipient lists — Outlook
 * adds them to To so the person a message mentions also receives it.
 */
export const unaddressedMentions = (
  mentioned: readonly MentionPerson[],
  recipients: readonly (string | RawEmailAddress)[],
): MentionPerson[] => {
  const addressed = new Set(
    recipients.map(r => normalize(typeof r === 'string' ? r : (r.emailAddress?.address ?? ''))),
  );
  return mentioned.filter(person => !addressed.has(normalize(person.address)));
};

/** How to write mentions, for the descriptions of the tools that compose a body. */
export const MENTION_HELP =
  'Write @[Name] to @mention someone on the email or thread, by first name as a person would (@[Ratnakar]): the ' +
  'tag shows the text written. When a first name is not unique, @[Ratnakar](Ratnakar Bhide) or ' +
  '@[Ratnakar](name@example.com) shows the first name and tags that person; @[name@example.com] tags anyone by ' +
  'email. A tagged person not yet a recipient is added to To.';
