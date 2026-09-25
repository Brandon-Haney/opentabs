import { z } from 'zod';

// ---------------------------------------------------------------------------
// Conversation (chat) schema
// ---------------------------------------------------------------------------

export const conversationSchema = z.object({
  id: z.string().describe('Conversation/thread ID'),
  topic: z.string().describe('Chat name/topic (empty for unnamed 1:1 chats)'),
  type: z.string().describe('Conversation type (e.g., "Conversation")'),
  thread_type: z.string().describe('Thread type (e.g., "chat", "meeting", "space")'),
  member_count: z.string().describe('Number of members in the conversation'),
  created_at: z.string().describe('When the conversation was created (ISO 8601)'),
  last_message_content: z.string().describe('Content of the last message'),
  last_message_type: z.string().describe('Message type of the last message'),
  last_message_time: z.string().describe('Timestamp of the last message'),
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

export const mapConversation = (c: RawConversation): Conversation => ({
  id: c.id ?? '',
  topic: String(c.threadProperties?.topic ?? ''),
  type: c.type ?? '',
  thread_type: String(c.threadProperties?.threadType ?? ''),
  member_count: String(c.threadProperties?.memberCount ?? ''),
  created_at: String(c.threadProperties?.createdat ?? ''),
  last_message_content: String(c.lastMessage?.content ?? ''),
  last_message_type: String(c.lastMessage?.messagetype ?? ''),
  last_message_time: String(c.lastMessage?.composetime ?? ''),
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
// Message schema
// ---------------------------------------------------------------------------

export const messageSchema = z.object({
  id: z.string().describe('Message ID (timestamp-based)'),
  client_message_id: z.string().describe('Client-assigned message ID'),
  content: z.string().describe('Message content (may contain HTML)'),
  message_type: z.string().describe('Message type (e.g., "RichText/Html", "Text")'),
  from: z.string().describe('Sender MRI (e.g., "8:orgid:username")'),
  display_name: z.string().describe('Sender display name'),
  compose_time: z.string().describe('When the message was composed (ISO 8601)'),
  conversation_id: z.string().describe('ID of the conversation this message belongs to'),
  mentions: z.array(mentionSchema).describe('Users mentioned in this message'),
  files: z.array(fileSchema).describe('Files attached to this message'),
  reactions: z.array(z.string()).describe('Reaction emoji keys on this message (e.g., ["like", "heart"])'),
});

export type Message = z.infer<typeof messageSchema>;

interface RawMention {
  mri?: string;
  displayName?: string;
}

interface RawFile {
  title?: string;
  type?: string;
  objectUrl?: string;
}

interface RawMessage {
  id?: string;
  clientmessageid?: string;
  content?: string;
  messagetype?: string;
  from?: string;
  imdisplayname?: string;
  composetime?: string;
  conversationid?: string;
  properties?: {
    mentions?: string;
    files?: string;
    emotions?: Array<{ key?: string }>;
  };
  annotationsSummary?: {
    emotions?: Array<{ key?: string }>;
  };
}

/** Extract the MRI (e.g., "8:live:username") from a full contact URL. */
const extractMri = (from: string): string => {
  const match = /\/contacts\/(.+)$/.exec(from);
  return match?.[1] ?? from;
};

/** Parse mentions from the serialized JSON string in properties.mentions. */
const parseMentions = (raw?: string): Array<{ mri: string; display_name: string }> => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as RawMention[];
    return arr.map(m => ({ mri: m.mri ?? '', display_name: m.displayName ?? '' }));
  } catch {
    return [];
  }
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

export const mapMessage = (m: RawMessage): Message => ({
  id: m.id ?? '',
  client_message_id: m.clientmessageid ?? '',
  content: m.content ?? '',
  message_type: m.messagetype ?? '',
  from: extractMri(m.from ?? ''),
  display_name: m.imdisplayname ?? '',
  compose_time: m.composetime ?? '',
  conversation_id: m.conversationid ?? '',
  mentions: parseMentions(m.properties?.mentions),
  files: parseFiles(m.properties?.files),
  reactions: parseReactions(m),
});

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
  sent_time: z.string().describe('When the message was sent (ISO 8601)'),
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
    sent_time: source.DateTimeSent ?? '',
    has_attachments: source.HasAttachments ?? false,
  };
};

// ---------------------------------------------------------------------------
// Calendar event schema
// ---------------------------------------------------------------------------

export const calendarEventSchema = z.object({
  id: z.string().describe('Exchange event ID (the same ID the Outlook plugin uses for this event)'),
  subject: z.string().describe('Event subject'),
  start: z.string().describe('Start time (ISO 8601, UTC)'),
  end: z.string().describe('End time (ISO 8601, UTC)'),
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

/** Normalize a middle-tier timestamp (`2026-09-25T13:30:00+00:00`) to ISO 8601 UTC; empty when absent or invalid. */
const toUtcIso = (timestamp: string | undefined): string => {
  if (!timestamp) return '';
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
};

export const mapCalendarEvent = (e: RawCalendarEvent): CalendarEvent => ({
  id: e.objectId ?? '',
  subject: e.subject ?? '',
  start: toUtcIso(e.startTime),
  end: toUtcIso(e.endTime),
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
