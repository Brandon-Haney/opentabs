import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { type MakerWorldList, mapRedemption, type RawRedemption, redemptionSchema } from './schemas.js';

export const listRedemptions = defineTool({
  name: 'list_redemptions',
  displayName: 'List Redemption History',
  description:
    'List past point redemptions, newest first, with the points spent and the regular/exclusive split for each. Use this to measure historical redemption cadence and to calculate realised value per point.',
  summary: 'List past point redemptions',
  icon: 'history',
  group: 'Points',
  input: z.object({
    offset: z.number().int().min(0).optional().describe('Number of entries to skip (default 0)'),
    limit: z.number().int().min(1).max(100).optional().describe('Entries per page (default 20, max 100)'),
  }),
  output: z.object({
    redemptions: z.array(redemptionSchema).describe('Past redemptions, newest first'),
    total: z.number().describe('Total number of redemptions'),
  }),
  handle: async params => {
    const data = await api<MakerWorldList<RawRedemption>>('point-service', '/redeem/history', {
      query: { offset: params.offset ?? 0, limit: params.limit ?? 20 },
    });

    return {
      redemptions: (data.hits ?? []).map(mapRedemption),
      total: data.total ?? 0,
    };
  },
});
