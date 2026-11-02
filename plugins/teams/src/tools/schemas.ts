import { z } from 'zod';
import { extractMessageImages } from '../ams-image.js';
import { decodeEntities } from '../html-entities.js';
import { toLocalIso } from '../local-time.js';
import { messagePreview } from '../message-preview.js';
import { teamsHtmlToMarkdown } from '../teams-markdown.js';

// ---------------------------------------------------------------------------
// Conversation (chat) schema
// ---------------------------------------------------------------------------

export const conversationSchema = z.object({
  id: z.string().describe('Conversation/thread ID'),
  topic: z
    .string()
    .describe(
      'Chat or channel name (empty for unnamed 1:1 chats). A team\'s General channel carries the team\'s name, with thread_type "space".',
    ),
  participants: z
    .array(z.string())
    .nullable()
    .describe(
      'The other people in a chat with no topic, by name. Null for a chat with a topic, for a channel, or when names could not be looked up.',
    ),
  type: z.string().describe('Conversation type (e.g., "Conversation")'),
  thread_type: z.string().describe('Thread type (e.g., "chat", "meeting", "space")'),
  created_at: z.string().describe('When the conversation was created (ISO 8601 in local time, with its UTC offset)'),
  last_message_preview: z
    .string()
    .describe(
      'The last message on one line, as Teams previews it (cut to 200 characters), or its type in brackets when it is not a chat message, such as a call; read_messages gives messages in full',
    ),
  last_message_type: z.string().describe('Message type of the last message'),
  last_message_time: z
    .string()
    .describe('When the last message was composed (ISO 8601 in local time, with its UTC offset)'),
  last_message_from: z.string().describe('Display name of the last message sender'),
  version: z.number().describe('Conversation version'),
});

export type Conversation = z.infer<typeof conversationSchema>;

interface RawConversation {
  id?: string;
  type?: string;
  threadProperties?: Record<string, unknown>;
  lastMessage?: Record<string, unknown>;
  version?: number;
}

const CHANNEL_THREAD_TYPES = new Set(['space', 'topic']);

/** Whether a thread type is a channel: `space` is a team's General channel, `topic` any other channel. */
export const isChannelThreadType = (threadType: string): boolean => CHANNEL_THREAD_TYPES.has(threadType);

/** A thread's name. A chat or channel holds it in `topic`; a team's General channel only in `spaceThreadTopic`. */
export const threadName = (properties: Record<string, unknown> | undefined): string =>
  String(properties?.topic || properties?.spaceThreadTopic || '');

/** Message types that carry chat text; any other type is an event, such as a call or a membership change. */
export const CHAT_MESSAGE_TYPES: ReadonlySet<string> = new Set(['RichText/Html', 'Text', 'RichText']);

/** A conversation's last message as Teams previews it, or its type when it is an event rather than chat text. */
const lastMessagePreview = (lastMessage: Record<string, unknown> | undefined): string => {
  const type = String(lastMessage?.messagetype ?? '');
  const content = String(lastMessage?.content ?? '');
  if (content.trim() === '') return '';
  if (!CHAT_MESSAGE_TYPES.has(type)) return `[${type}]`;
  // The quote-card preview keeps each non-breaking space; a list preview collapses them.
  return messagePreview({ content, properties: lastMessage?.properties as RawMessage['properties'] })
    .replace(/ {2,}/g, ' ')
    .trim();
};

export const mapConversation = (c: RawConversation): Conversation => ({
  id: c.id ?? '',
  topic: threadName(c.threadProperties),
  participants: null,
  type: c.type ?? '',
  thread_type: String(c.threadProperties?.threadType ?? ''),
  created_at: toLocalIso(String(c.threadProperties?.createdat ?? '')),
  last_message_preview: lastMessagePreview(c.lastMessage),
  last_message_type: String(c.lastMessage?.messagetype ?? ''),
  last_message_time: toLocalIso(String(c.lastMessage?.composetime ?? '')),
  last_message_from: String(c.lastMessage?.imdisplayname ?? ''),
  version: typeof c.version === 'number' ? c.version : 0,
});

// ---------------------------------------------------------------------------
// Mention schema
// ---------------------------------------------------------------------------

const mentionSchema = z.object({
  mri: z.string().describe('Mentioned user MRI (e.g., "8:orgid:...")'),
  display_name: z.string().describe('Display name of the mentioned user'),
});

// ---------------------------------------------------------------------------
// File attachment schema
// ---------------------------------------------------------------------------

const fileSchema = z.object({
  title: z.string().describe('File name'),
  type: z.string().describe('File type (e.g., "image/png", "application/pdf")'),
  url: z.string().describe('File download URL'),
});

// ---------------------------------------------------------------------------
// Inline image schema
// ---------------------------------------------------------------------------

const imageSchema = z.object({
  object_id: z.string().describe('Teams media object ID'),
  url: z.string().describe('Full-resolution image URL — pass to download_image to save the original file'),
});

// ---------------------------------------------------------------------------
// Meeting post schema
// ---------------------------------------------------------------------------

const meetingSchema = z.object({
  title: z.string().describe('Meeting title'),
  start: z.string().describe('Start time (ISO 8601 in local time, with its UTC offset)'),
  end: z.string().describe('End time (ISO 8601 in local time, with its UTC offset)'),
  location: z.string().describe('Location (empty if none)'),
  is_cancelled: z.boolean().describe('Whether this post announces that the meeting was cancelled'),
  join_url: z.string().describe('Teams meeting join URL (empty if none)'),
});

interface RawMeeting {
  '@type'?: string;
  meetingtitle?: string;
  meetingJoinUrl?: string;
  scheduledmeetinginfo?: { startTime?: string; endTime?: string; location?: string; isCancelled?: boolean };
}

/** The meeting a channel post announces, from the JSON string in properties.meeting; null when there is none. */
const parseMeeting = (raw: string | undefined): z.infer<typeof meetingSchema> | null => {
  if (!raw) return null;
  let meeting: RawMeeting;
  try {
    meeting = JSON.parse(raw) as RawMeeting;
  } catch {
    return null;
  }
  const info = meeting.scheduledmeetinginfo ?? {};
  return {
    title: meeting.meetingtitle ?? '',
    start: toLocalIso(info.startTime),
    end: toLocalIso(info.endTime),
    location: info.location ?? '',
    is_cancelled: info.isCancelled === true || meeting['@type'] === 'http://schema.skype.com/ScheduledMeetingCancelled',
    join_url: meeting.meetingJoinUrl ?? '',
  };
};

// ---------------------------------------------------------------------------
// Message schema
// ---------------------------------------------------------------------------

const quotedMessageSchema = z.object({
  id: z.string().describe('ID of the quoted message'),
  author: z.string().describe('Display name of its author'),
  preview: z.string().describe('The quote card’s one-line preview of it'),
});

/** How read_messages returns message text. */
export const messageFormatSchema = z.enum(['markdown', 'html']);
export type MessageFormat = z.infer<typeof messageFormatSchema>;

export const messageSchema = z.object({
  id: z.string().describe('Message ID (timestamp-based)'),
  client_message_id: z.string().describe('Client-assigned message ID'),
  content: z
    .string()
    .describe(
      'Message text as Markdown, in the form send_message and edit_message take (format "html" gives the HTML Teams stores); empty on a deleted message',
    ),
  quoted_message: quotedMessageSchema
    .nullable()
    .describe('The message a reply quotes, from the quote card it opens with; the card is not part of content'),
  deleted: z.boolean().describe('Whether the message was deleted'),
  edited_at: z
    .string()
    .nullable()
    .describe(
      'When the message was last edited (ISO 8601 in local time, with its UTC offset), or null if it never was',
    ),
  message_type: z.string().describe('Message type (e.g., "RichText/Html", "Text")'),
  from: z.string().describe('Sender MRI (e.g., "8:orgid:username")'),
  display_name: z.string().describe('Sender display name'),
  compose_time: z.string().describe('When the message was composed (ISO 8601 in local time, with its UTC offset)'),
  conversation_id: z.string().describe('ID of the conversation this message belongs to'),
  reply_to_post_id: z
    .string()
    .nullable()
    .describe('In a channel, the id of the post this message replies to; null for a post, and in a chat'),
  meeting: meetingSchema.nullable().describe('The meeting this channel post announces; null when it announces none'),
  mentions: z.array(mentionSchema).describe('Users mentioned in this message'),
  files: z.array(fileSchema).describe('Files attached to this message'),
  images: z.array(imageSchema).describe('Images embedded in the message, in the order content marks them [image]'),
  reactions: z.array(z.string()).describe('Reaction emoji keys on this message (e.g., ["like", "heart"])'),
});

export type Message = z.infer<typeof messageSchema>;

interface RawMention {
  itemid?: string | number;
  mri?: string;
  displayName?: string;
}

interface RawFile {
  title?: string;
  type?: string;
  objectUrl?: string;
}

export interface RawMessage {
  id?: string;
  clientmessageid?: string;
  content?: string;
  messagetype?: string;
  from?: string;
  imdisplayname?: string;
  composetime?: string;
  conversationid?: string;
  rootMessageId?: string;
  properties?: {
    mentions?: string;
    files?: string;
    meeting?: string;
    deletetime?: number | string;
    edittime?: number | string;
    emotions?: Array<{ key?: string }>;
  };
  annotationsSummary?: {
    emotions?: Array<{ key?: string }>;
  };
}

/** Extract the MRI (e.g., "8:live:username") from a full contact URL. */
export const extractMri = (from: string): string => {
  const match = /\/contacts\/(.+)$/.exec(from);
  return match?.[1] ?? from;
};

/** The mentions in the serialized JSON string in properties.mentions. */
const rawMentions = (raw?: string): RawMention[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RawMention[]) : [];
  } catch {
    return [];
  }
};

const parseMentions = (raw?: string): Array<{ mri: string; display_name: string }> =>
  rawMentions(raw).map(m => ({ mri: m.mri ?? '', display_name: m.displayName ?? '' }));

/** Each mention's full display name by the `itemid` its span carries in the message HTML. */
const mentionNames = (raw?: string): Map<string, string> =>
  new Map(
    rawMentions(raw).flatMap(m => (m.itemid !== undefined && m.displayName ? [[String(m.itemid), m.displayName]] : [])),
  );

/** A message's text in the requested format, and the message its quote card names. */
const messageText = (
  m: RawMessage,
  format: MessageFormat,
): { content: string; quoted: z.infer<typeof quotedMessageSchema> | null } => {
  const content = m.content ?? '';
  if (m.messagetype === 'Text') return { content: format === 'html' ? content : decodeEntities(content), quoted: null };
  const { markdown, quoted } = teamsHtmlToMarkdown(content, mentionNames(m.properties?.mentions));
  return { content: format === 'html' ? content : markdown, quoted };
};

/** Parse files from the serialized JSON string in properties.files. */
const parseFiles = (raw?: string): Array<{ title: string; type: string; url: string }> => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as RawFile[];
    return arr.map(f => ({ title: f.title ?? '', type: f.type ?? '', url: f.objectUrl ?? '' }));
  } catch {
    return [];
  }
};

/** Extract unique reaction keys from emotions/annotationsSummary. */
const parseReactions = (msg: RawMessage): string[] => {
  const emotions = msg.properties?.emotions ?? msg.annotationsSummary?.emotions ?? [];
  const keys = new Set<string>();
  for (const e of emotions) {
    if (e.key) keys.add(e.key);
  }
  return [...keys];
};

/** A timestamp property in epoch milliseconds, as local ISO 8601; null when absent or zero. */
const isoFromEpochProperty = (value: number | string | undefined): string | null => {
  const epochMs = Number(value);
  return epochMs > 0 ? toLocalIso(epochMs) : null;
};

export const mapMessage = (m: RawMessage, format: MessageFormat = 'markdown'): Message => {
  const { content, quoted } = messageText(m, format);
  return {
    id: m.id ?? '',
    client_message_id: m.clientmessageid ?? '',
    content,
    quoted_message: quoted,
    deleted: isoFromEpochProperty(m.properties?.deletetime) !== null,
    edited_at: isoFromEpochProperty(m.properties?.edittime),
    message_type: m.messagetype ?? '',
    from: extractMri(m.from ?? ''),
    display_name: m.imdisplayname ?? '',
    compose_time: toLocalIso(m.composetime),
    conversation_id: m.conversationid ?? '',
    reply_to_post_id: m.rootMessageId && m.rootMessageId !== m.id ? m.rootMessageId : null,
    meeting: parseMeeting(m.properties?.meeting),
    mentions: parseMentions(m.properties?.mentions),
    files: parseFiles(m.properties?.files),
    images: extractMessageImages(m.content ?? '').map(image => ({ object_id: image.objectId, url: image.fullSizeUrl })),
    reactions: parseReactions(m),
  };
};

// ---------------------------------------------------------------------------
// Message search result schema (Substrate Search API)
// ---------------------------------------------------------------------------

export const messageSearchResultSchema = z.object({
  id: z.string().describe('Message ID'),
  conversation_id: z
    .string()
    .describe('Thread ID of the chat/channel the message belongs to — pass to read_messages to read the conversation'),
  thread_type: z.string().describe('Thread type (e.g., "chat", "meeting", "topic" for a channel)'),
  from: z.string().describe('Sender display name'),
  from_address: z.string().describe('Sender email address'),
  subject: z.string().describe('Message subject (empty for chat messages)'),
  summary: z.string().describe('Hit-highlighted snippet of the matching message (may contain HTML)'),
  sent_time: z.string().describe('When the message was sent (ISO 8601 in local time, with its UTC offset)'),
  has_attachments: z.boolean().describe('Whether the message has file attachments'),
});

export type MessageSearchResult = z.infer<typeof messageSearchResultSchema>;

interface RawSearchResult {
  Id?: string;
  HitHighlightedSummary?: string;
  Source?: {
    ClientThreadId?: string;
    Subject?: string;
    Preview?: string;
    DateTimeSent?: string;
    HasAttachments?: boolean;
    From?: { EmailAddress?: { Name?: string; Address?: string } };
    Extensions?: { SkypeSpaces_ConversationPost_Extension_ThreadType?: string };
  };
}

export const mapSearchResult = (r: RawSearchResult): MessageSearchResult => {
  const source = r.Source ?? {};
  const email = source.From?.EmailAddress ?? {};
  return {
    id: r.Id ?? '',
    conversation_id: source.ClientThreadId ?? '',
    thread_type: source.Extensions?.SkypeSpaces_ConversationPost_Extension_ThreadType ?? '',
    from: email.Name ?? '',
    from_address: email.Address ?? '',
    subject: source.Subject ?? '',
    summary: r.HitHighlightedSummary ?? source.Preview ?? '',
    sent_time: toLocalIso(source.DateTimeSent),
    has_attachments: source.HasAttachments ?? false,
  };
};

// ---------------------------------------------------------------------------
// Calendar event schema
// ---------------------------------------------------------------------------

export const calendarEventSchema = z.object({
  id: z.string().describe('Exchange event ID (the same ID the Outlook plugin uses for this event)'),
  subject: z.string().describe('Event subject'),
  start: z.string().describe('Start time (ISO 8601 in local time, with its UTC offset)'),
  end: z.string().describe('End time (ISO 8601 in local time, with its UTC offset)'),
  is_all_day: z.boolean().describe('Whether the event is an all-day event'),
  location: z.string().describe('Location display name (empty if none)'),
  type: z
    .string()
    .describe('"SingleInstance", "Occurrence" (of a recurring series), or "Exception" (a modified occurrence)'),
  is_online_meeting: z.boolean().describe('Whether the event is a Teams meeting'),
  join_url: z.string().describe('Teams meeting join URL (empty if not a Teams meeting)'),
  meeting_chat_id: z
    .string()
    .describe('Thread ID of the meeting chat, usable with read_messages and send_message (empty if none)'),
  dial_in_conference_id: z.string().describe('Audio conference ID for dial-in (empty if none)'),
  dial_in_toll_number: z.string().describe('Dial-in toll number (empty if none)'),
  organizer_name: z.string().describe('Organizer display name'),
  is_organizer: z.boolean().describe('Whether the signed-in user organizes the event'),
  response: z.string().describe('The signed-in user\'s response, e.g. "Accepted", "Tentative", "Organizer", "None"'),
  show_as: z.string().describe('Free/busy status, e.g. "Busy", "Tentative", "Free", "Oof"'),
  is_private: z.boolean().describe('Whether the event is marked private'),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export interface RawCalendarEvent {
  objectId?: string;
  subject?: string;
  startTime?: string;
  endTime?: string;
  isAllDayEvent?: boolean;
  location?: string;
  eventType?: string | null;
  isOnlineMeeting?: boolean;
  skypeTeamsMeetingUrl?: string;
  skypeTeamsData?: string;
  onlineMeetingConferenceId?: string;
  onlineMeetingTollNumber?: string;
  organizerName?: string;
  isOrganizer?: boolean;
  myResponseType?: string;
  showAs?: string;
  isPrivate?: boolean;
}

/**
 * The meeting chat thread ID from `skypeTeamsData`, a JSON string whose `cid`
 * names the chat; empty when absent or unparseable.
 */
const meetingChatIdOf = (skypeTeamsData: string | undefined): string => {
  if (!skypeTeamsData) return '';
  try {
    const cid = (JSON.parse(skypeTeamsData) as { cid?: unknown }).cid;
    return typeof cid === 'string' ? cid : '';
  } catch {
    return '';
  }
};

export const mapCalendarEvent = (e: RawCalendarEvent): CalendarEvent => ({
  id: e.objectId ?? '',
  subject: e.subject ?? '',
  start: toLocalIso(e.startTime),
  end: toLocalIso(e.endTime),
  is_all_day: e.isAllDayEvent ?? false,
  location: e.location ?? '',
  // The middle tier leaves eventType null for a single, non-recurring event.
  type: e.eventType ?? 'SingleInstance',
  is_online_meeting: e.isOnlineMeeting ?? false,
  join_url: e.skypeTeamsMeetingUrl ?? '',
  meeting_chat_id: meetingChatIdOf(e.skypeTeamsData),
  dial_in_conference_id: e.onlineMeetingConferenceId ?? '',
  dial_in_toll_number: e.onlineMeetingTollNumber ?? '',
  organizer_name: e.organizerName ?? '',
  is_organizer: e.isOrganizer ?? false,
  response: e.myResponseType ?? '',
  show_as: e.showAs ?? '',
  is_private: e.isPrivate ?? false,
});
