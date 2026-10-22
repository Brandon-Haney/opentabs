import {
  LOCAL_FILE_PATH_FORMAT,
  type ProgressOptions,
  readLocalFile,
  ToolError,
  type ToolHandlerContext,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { base64ToBytes, buildFileEntry, chatFileUrl } from './chat-files.js';
import { findMentions, isEmailMention, matchPerson, renderMentions } from './chat-mentions.js';
import { markdownToTeamsHtml } from './markdown-html.js';
import {
  type ChatFileLink,
  createChatFileLink,
  type DirectoryUser,
  getDirectoryUsers,
  getDriveWebUrl,
  getGraphUserId,
  threadApi,
  uploadChatFile,
} from './teams-api.js';

/**
 * Turns a send request — Markdown text with `@[...]` mentions, plus files on
 * the user's computer — into the chat service message body: the HTML content
 * and the `properties` that make mentions notify and files appear.
 */

/** The self chat ("Notes" with yourself), which has no member list. */
const SELF_CHAT_ID = '48:notes';

/** Thread types of channel conversations, whose files live in the team's SharePoint site rather than OneDrive. */
const CHANNEL_THREAD_TYPES = new Set(['space', 'topic']);

export const fileAccessSchema = z
  .enum(['view', 'edit'])
  .describe('What the conversation’s members may do with attached files (default "view").');

export const attachedFilePathSchema = z
  .string()
  .min(1)
  .meta({ format: LOCAL_FILE_PATH_FORMAT })
  .describe(
    'Absolute path of a file on this computer, e.g. "C:\\Users\\me\\Documents\\report.csv". The file is read from ' +
      'disk — pass the path, never the contents.',
  );

/** What the caller asked to send. */
export interface OutgoingMessage {
  conversationId: string;
  text: string;
  files: string[];
  fileAccess: 'view' | 'edit';
}

/** A mention as the tool reports it. */
export interface SentMention {
  text: string;
  display_name: string;
  email: string;
}

/** An attached file as the tool reports it. */
export interface SentFile {
  name: string;
  url: string;
  shared_with: number;
}

/** The chat service body fields for the message, and what was mentioned and attached. */
export interface ComposedMessage {
  content: string;
  properties: Record<string, string>;
  mentions: SentMention[];
  files: SentFile[];
}

const emailOf = (person: DirectoryUser): string => person.mail ?? person.userPrincipalName;

/**
 * How often a long step reports its progress again. The platform ends a tool
 * that reports nothing for 25 seconds, and uploading a large file or sharing it
 * with a large chat takes longer than that.
 */
const PROGRESS_HEARTBEAT_MS = 10_000;

/** Run one step of the send, reporting it when it starts and again every PROGRESS_HEARTBEAT_MS until it settles. */
const runReportedStep = async <T>(
  context: ToolHandlerContext | undefined,
  progress: ProgressOptions,
  step: () => Promise<T>,
): Promise<T> => {
  if (!context) return step();
  context.reportProgress(progress);
  const heartbeat = setInterval(() => context.reportProgress(progress), PROGRESS_HEARTBEAT_MS);
  try {
    return await step();
  } finally {
    clearInterval(heartbeat);
  }
};

/** The conversation's members as directory users, and whether it is a channel. */
const conversationPeople = async (conversationId: string): Promise<{ people: DirectoryUser[]; isChannel: boolean }> => {
  if (conversationId === SELF_CHAT_ID) {
    return { people: await getDirectoryUsers([getGraphUserId()]), isChannel: false };
  }
  const thread = await threadApi<{
    properties?: Record<string, unknown>;
    members?: Array<{ id?: string }>;
  }>(conversationId, '?view=msnp24Equivalent');
  const ids = (thread.members ?? [])
    .map(member => member.id ?? '')
    .filter(id => id.startsWith('8:orgid:'))
    .map(id => id.slice('8:orgid:'.length));
  return {
    people: await getDirectoryUsers(ids),
    isChannel: CHANNEL_THREAD_TYPES.has(String(thread.properties?.threadType ?? '')),
  };
};

/**
 * Build the message. Mentions resolve before any file is uploaded, so a name
 * that matches no one fails the send without leaving files behind in OneDrive.
 */
export const composeMessage = async (
  message: OutgoingMessage,
  context: ToolHandlerContext | undefined,
): Promise<ComposedMessage> => {
  const mentionTargets = findMentions(message.text).map(mention => mention.target);
  if (mentionTargets.length === 0 && message.files.length === 0) {
    return { content: markdownToTeamsHtml(message.text), properties: {}, mentions: [], files: [] };
  }

  const { people, isChannel } = await conversationPeople(message.conversationId);
  if (message.files.length > 0 && isChannel) {
    throw ToolError.validation(
      'Attaching files is supported in chats, not channels: a channel keeps its files in the team’s SharePoint ' +
        'site. Upload the file there and link it in the message instead.',
    );
  }

  // A mention by email may name someone outside the conversation.
  const known = new Set(people.flatMap(p => [p.mail?.toLowerCase(), p.userPrincipalName.toLowerCase()]));
  const emailsToLookUp = [
    ...new Set(mentionTargets.filter(isEmailMention).filter(email => !known.has(email.toLowerCase()))),
  ];
  const directory = emailsToLookUp.length > 0 ? [...people, ...(await getDirectoryUsers(emailsToLookUp))] : people;

  const mentions: SentMention[] = [];
  const rendered = renderMentions(message.text, ({ text, target }) => {
    const person = matchPerson(target, isEmailMention(target) ? directory : people);
    mentions.push({ text, display_name: person.displayName, email: emailOf(person) });
    return person;
  });

  const files: SentFile[] = [];
  const fileEntries: Record<string, unknown>[] = [];
  if (message.files.length > 0) {
    const local = message.files.map(path => readLocalFile(context, path));
    const selfId = getGraphUserId();
    const recipients = people.filter(p => p.id !== selfId).map(emailOf);
    const driveWebUrl = await getDriveWebUrl();
    // Each file takes two steps: its upload, then its sharing link.
    const total = local.length * 2;
    for (const [index, file] of local.entries()) {
      const item = await runReportedStep(
        context,
        { progress: index * 2, total, message: `Uploading ${file.name}` },
        () => uploadChatFile(file.name, base64ToBytes(file.contentBase64), file.contentType),
      );
      let link: ChatFileLink | null = null;
      if (recipients.length > 0) {
        link = await runReportedStep(
          context,
          {
            progress: index * 2 + 1,
            total,
            message: `Sharing ${item.name} with ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}`,
          },
          () => createChatFileLink(item.id, recipients, message.fileAccess),
        );
      }
      fileEntries.push(buildFileEntry(item, driveWebUrl, link));
      files.push({ name: item.name, url: chatFileUrl(driveWebUrl, item.name), shared_with: recipients.length });
    }
  }

  const properties: Record<string, string> = {};
  if (rendered.mentionsProperty !== null) properties.mentions = rendered.mentionsProperty;
  if (fileEntries.length > 0) properties.files = JSON.stringify(fileEntries);
  return {
    content: message.text.trim().length === 0 ? '' : rendered.html,
    properties,
    mentions,
    files,
  };
};
