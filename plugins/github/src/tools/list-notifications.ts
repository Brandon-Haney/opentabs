import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { mapNotification, notificationSchema } from './schemas.js';

export const listNotifications = defineTool({
  name: 'list_notifications',
  displayName: 'List Notifications',
  description: 'List notifications for the authenticated user. Includes issue, PR, and release notifications.',
  icon: 'bell',
  input: z.object({
    all: z.boolean().optional().describe('Show all notifications including read ones (default: false)'),
    participating: z
      .boolean()
      .optional()
      .describe('Only show notifications where the user is directly participating (default: false)'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    notifications: z.array(notificationSchema).describe('List of notifications'),
  }),
  handle: async params => {
    const query: Record<string, string | number | boolean | undefined> = {
      per_page: params.per_page ?? 30,
      page: params.page,
    };
    if (params.all !== undefined) query.all = params.all;
    if (params.participating !== undefined) query.participating = params.participating;

    const data = await api<Record<string, unknown>[]>('/notifications', {
      query,
    });
    return { notifications: (data ?? []).map(mapNotification) };
  },
});
