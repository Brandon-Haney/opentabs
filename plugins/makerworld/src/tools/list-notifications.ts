import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import type { MakerWorldList } from './schemas.js';

/**
 * Notification payloads are nested under a key named for the notification kind
 * (`taskMessage`, `commentMessage`, and so on) rather than a common field, and
 * the set of kinds is not published. Rather than enumerate them, the mapper
 * picks the single nested object on the envelope and reads shared fields from it.
 */
interface RawNotificationPayload {
  title?: string;
  detail?: string;
  content?: string;
  designId?: number;
  designTitle?: string;
}

interface RawNotification {
  id?: number;
  type?: number | string;
  isread?: number;
  createTime?: string;
  [payloadKey: string]: unknown;
}

/** Envelope keys that are metadata rather than the notification payload. */
const ENVELOPE_KEYS = new Set(['id', 'type', 'isread', 'createTime', 'from']);

const extractPayload = (n: RawNotification): RawNotificationPayload => {
  for (const [key, value] of Object.entries(n)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as RawNotificationPayload;
    }
  }
  return {};
};

export const listNotifications = defineTool({
  name: 'list_notifications',
  displayName: 'List Notifications',
  description:
    'List account notifications — print job results, comments and ratings on your models, boosts received, follows, and system messages — newest first, each flagged read or unread. Notifications that reference one of your models carry its ID and title. Use this to catch activity without opening the site.',
  summary: 'List account notifications',
  icon: 'bell',
  group: 'Account',
  input: z.object({
    offset: z.number().int().min(0).optional().describe('Number of notifications to skip (default 0)'),
    limit: z.number().int().min(1).max(100).optional().describe('Notifications per page (default 20, max 100)'),
  }),
  output: z.object({
    notifications: z
      .array(
        z.object({
          id: z.number().describe('Notification ID'),
          type: z.string().describe('Numeric notification type identifier'),
          title: z.string().describe('Notification title, empty when the type carries none'),
          content: z.string().describe('Notification detail text, empty when the type carries none'),
          design_id: z.number().describe('Related model ID, 0 when the notification is not about a model'),
          design_title: z.string().describe('Related model title, empty when not about a model'),
          is_read: z.boolean().describe('Whether the notification has been read'),
          created_at: z.string().describe('ISO 8601 timestamp'),
        }),
      )
      .describe('Notifications, newest first'),
    count: z.number().describe('Number of notifications returned on this page'),
  }),
  handle: async params => {
    const data = await api<MakerWorldList<RawNotification>>('user-service', '/my/messages', {
      query: { offset: params.offset ?? 0, limit: params.limit ?? 20 },
    });

    const notifications = (data.hits ?? []).map(n => {
      const payload = extractPayload(n);
      return {
        id: n.id ?? 0,
        type: String(n.type ?? ''),
        title: payload.title ?? '',
        content: payload.detail ?? payload.content ?? '',
        design_id: payload.designId ?? 0,
        design_title: payload.designTitle ?? '',
        is_read: n.isread === 1,
        created_at: n.createTime ?? '',
      };
    });

    return { notifications, count: notifications.length };
  },
});
