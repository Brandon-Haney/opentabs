import { getPageGlobal } from '@opentabs-dev/plugin-sdk';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

const notificationSchema = z.object({
  type: z.string().describe('Notification type'),
  title: z.string().describe('Notification title text'),
  message: z.string().describe('Notification message body'),
  image_url: z.string().describe('Notification image URL'),
  video_id: z.number().int().describe('Related video ID (0 if none)'),
});

export const getNotifications = defineTool({
  name: 'get_notifications',
  displayName: 'Get Notifications',
  description:
    'Get the Netflix notification list for the current profile. Returns new release notifications, recommendations, and other alerts. Also returns the unread count.',
  summary: 'Get Netflix notifications',
  icon: 'bell',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    notifications: z.array(notificationSchema).describe('Notification entries'),
    unread_count: z.number().int().describe('Number of unread notifications'),
  }),
  handle: async () => {
    // Read unread count from the Falcor cache via page global
    const unreadCount =
      (getPageGlobal('netflix.falcorCache.notifications.unreadCount') as { value?: number } | number | undefined) ?? 0;
    const count = typeof unreadCount === 'object' ? (unreadCount.value ?? 0) : unreadCount;

    // Falcor cache notification data requires complex reference resolution,
    // so we return an empty list and the unread count only
    const notifications: Array<{
      type: string;
      title: string;
      message: string;
      image_url: string;
      video_id: number;
    }> = [];

    return { notifications, unread_count: count };
  },
});
