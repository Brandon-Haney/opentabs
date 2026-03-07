import { z } from 'zod';

export const participantSchema = z.object({
  email: z.string().describe('Email address'),
  name: z.string().describe('Display name'),
});

export const threadSummarySchema = z.object({
  thread_id: z.string().describe('Thread ID (e.g., "thread-f:1858936416969478478")'),
  subject: z.string().describe('Email subject line'),
  snippet: z.string().describe('Short preview of the email content'),
  from: participantSchema.describe('Sender of the most recent message'),
  timestamp: z.number().describe('Timestamp in milliseconds since epoch'),
  is_unread: z.boolean().describe('Whether the thread has unread messages'),
  is_starred: z.boolean().describe('Whether the thread is starred'),
  labels: z.array(z.string()).describe('Gmail labels applied to this thread'),
  message_count: z.number().describe('Number of messages in the thread'),
});

export const messageSchema = z.object({
  message_id: z.string().describe('Message ID (e.g., "msg-f:1858936416969478478")'),
  hex_id: z.string().describe('Hex message ID used for action API calls'),
  from: participantSchema.describe('Message sender'),
  to: z.array(participantSchema).describe('To recipients'),
  cc: z.array(participantSchema).describe('CC recipients'),
  subject: z.string().describe('Message subject'),
  snippet: z.string().describe('Short text preview'),
  body: z.string().describe('Full message body as plain text'),
  timestamp: z.number().describe('Timestamp in milliseconds since epoch'),
  labels: z.array(z.string()).describe('Gmail labels on this message'),
});

export const labelCountSchema = z.object({
  label: z.string().describe('Label name (e.g., "Inbox", "Sent", "Drafts")'),
  raw_label: z.string().describe('Internal Gmail label ID (e.g., "^i" for inbox)'),
  unread: z.number().describe('Number of unread messages'),
  total: z.number().describe('Total number of messages'),
});
