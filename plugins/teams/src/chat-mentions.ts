import { ToolError } from '@opentabs-dev/plugin-sdk';
import { escapeHtml, markdownToTeamsHtml } from './markdown-html.js';
import type { DirectoryUser } from './teams-api.js';

/**
 * @mentions in a sent message.
 *
 * A mention is two halves that must agree. The message HTML marks the mention
 * text with a span carrying an `itemid`:
 *
 *   <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Sandip</span>
 *
 * and the message's `properties.mentions` — a JSON string — names who that
 * `itemid` is, by MRI. The span alone renders as plain text and notifies no
 * one; the property is what makes it a mention. Each occurrence takes its own
 * `itemid`, so mentioning the same person twice lists them twice.
 *
 * Callers write a mention as `@[Name]` in the Markdown text. The name is
 * matched against the people in the conversation; `@[someone@example.com]`
 * names a person directly by email, for a conversation whose members are not
 * known (a channel) or a person outside it.
 */

const MENTION_TYPE = 'http://schema.skype.com/Mention';

/** `@[Name]` — no brackets or line breaks inside the name. */
const MENTION_PATTERN = /@\[([^\][\r\n]+)\]/g;

/** Mentions one message may carry; Teams itself caps a message's mentions near this. */
const MAX_MENTIONS = 20;

/** The text of every `@[Name]` in a message, in order, repeats included. */
export const findMentionNames = (markdown: string): string[] =>
  [...markdown.matchAll(MENTION_PATTERN)].map(match => (match[1] ?? '').trim()).filter(name => name.length > 0);

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
 * name or email match first, otherwise the person whose name contains every
 * word of the mention as the start of one of its words ("Sandip" or "Sandip K"
 * for "Sandip Kumar"). Throws a validation error naming the candidates when the
 * name matches several people, and the conversation's people when it matches
 * none, so the caller can correct it instead of sending a dead mention.
 */
export const matchPerson = (name: string, people: DirectoryUser[]): DirectoryUser => {
  const wanted = normalize(name);
  const exact = people.filter(
    p =>
      normalize(p.displayName) === wanted ||
      (p.mail !== null && normalize(p.mail) === wanted) ||
      normalize(p.userPrincipalName) === wanted,
  );
  if (exact.length === 1) return exact[0] as DirectoryUser;

  const queryWords = nameWords(name);
  const partial =
    exact.length > 1
      ? exact
      : people.filter(p => {
          const words = nameWords(p.displayName);
          return queryWords.length > 0 && queryWords.every(q => words.some(w => w.startsWith(q)));
        });
  const [only, ...rest] = partial;
  if (only && rest.length === 0) return only;

  if (partial.length > 1) {
    throw ToolError.validation(
      `@[${name}] matches ${partial.length} people in this conversation: ${partial
        .slice(0, 8)
        .map(p => `${p.displayName} (${p.mail ?? p.userPrincipalName})`)
        .join('; ')}. Use more of the name, or their email: @[name@example.com].`,
    );
  }
  const known = people.map(p => p.displayName).sort();
  throw ToolError.validation(
    `@[${name}] matches no one in this conversation` +
      (known.length > 0 ? ` (people here: ${known.slice(0, 25).join(', ')}${known.length > 25 ? ', …' : ''})` : '') +
      '. Check the spelling, or name them by email: @[name@example.com].',
  );
};

/** One mention of a person: who, and the text the message shows for them. */
export interface ResolvedMention {
  text: string;
  person: DirectoryUser;
}

/** The message HTML and `properties.mentions` value for a Markdown text whose mentions are resolved. */
export interface MentionedMessage {
  html: string;
  /** The JSON string `properties.mentions` carries, or null when the message mentions no one. */
  mentionsProperty: string | null;
}

/**
 * Render Markdown with its `@[Name]` mentions turned into mention spans.
 *
 * `resolve` maps each mention's name to its person; occurrences are numbered
 * in order of appearance, which is the `itemid` that ties each span to its
 * entry in the returned property. A mention naming its person by email shows
 * their display name; any other shows the text the caller wrote.
 */
export const renderMentions = (markdown: string, resolve: (name: string) => DirectoryUser): MentionedMessage => {
  const mentions: ResolvedMention[] = [];
  // Letters and digits only, so the Markdown converter passes them through untouched.
  const placeholder = (index: number): string => `OTBMENTION${index}X`;
  const withPlaceholders = markdown.replace(MENTION_PATTERN, (whole, rawName: string) => {
    const name = rawName.trim();
    if (name.length === 0) return whole;
    const person = resolve(name);
    mentions.push({ text: isEmailMention(name) ? person.displayName : name, person });
    return placeholder(mentions.length - 1);
  });
  if (mentions.length > MAX_MENTIONS) {
    throw ToolError.validation(
      `A message can mention at most ${MAX_MENTIONS} people; this one has ${mentions.length}.`,
    );
  }

  let html = markdownToTeamsHtml(withPlaceholders);
  mentions.forEach((mention, index) => {
    html = html.replace(
      placeholder(index),
      `<span itemtype="${MENTION_TYPE}" itemscope="" itemid="${index}">${escapeHtml(mention.text)}</span>`,
    );
  });

  return {
    html,
    mentionsProperty:
      mentions.length === 0
        ? null
        : JSON.stringify(
            mentions.map((mention, index) => ({
              '@type': MENTION_TYPE,
              itemid: String(index),
              mri: `8:orgid:${mention.person.id}`,
              mentionType: 'person',
              displayName: mention.person.displayName,
            })),
          ),
  };
};
