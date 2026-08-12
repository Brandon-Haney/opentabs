import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { mapProfileStats, profileStatsSchema, type RawProfileStats } from './schemas.js';

interface RawProfileStatsList {
  instList?: RawProfileStats[];
}

export const listProfileStats = defineTool({
  name: 'list_profile_stats',
  displayName: 'List Print Profile Performance',
  description:
    'Get per-print-profile performance for a date range: prints, downloads, points earned, and rating count. Print profiles earn points separately from their parent model, so use this to see which specific slicer configurations are producing income and which are not. Each row carries its parent model ID and title.',
  summary: 'Per-print-profile performance metrics for a date range',
  icon: 'layers',
  group: 'Analytics',
  input: z.object({
    start_date: z.string().describe('Start of the range, inclusive (YYYY-MM-DD)'),
    end_date: z.string().describe('End of the range, inclusive (YYYY-MM-DD)'),
    keyword: z.string().optional().describe('Filter to profiles whose title contains this text'),
  }),
  output: z.object({
    profiles: z.array(profileStatsSchema).describe('Per-print-profile metrics for the requested range'),
    count: z.number().describe('Number of print profiles returned'),
  }),
  handle: async params => {
    const data = await api<RawProfileStatsList>('design-user-service', '/my/creatortools/instance/list', {
      query: { startDate: params.start_date, endDate: params.end_date, keyword: params.keyword },
    });

    const profiles = (data.instList ?? []).map(mapProfileStats);
    return { profiles, count: profiles.length };
  },
});
