import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { mapModelStats, modelStatsSchema, type RawModelStats } from './schemas.js';

interface RawModelStatsList {
  modelList?: RawModelStats[];
}

export const listModelStats = defineTool({
  name: 'list_model_stats',
  displayName: 'List Model Performance',
  description:
    'Get per-model performance for a date range: impressions, views, likes, collects, prints, downloads, points earned, and boosts received, one row per published model. This is the primary tool for ranking best and worst performers and for computing conversion rates — impressions to views, views to prints, and points earned per impression. Covers whole models; use list_profile_stats for per-print-profile figures.',
  summary: 'Per-model performance metrics for a date range',
  icon: 'chart-bar',
  group: 'Analytics',
  input: z.object({
    start_date: z.string().describe('Start of the range, inclusive (YYYY-MM-DD)'),
    end_date: z.string().describe('End of the range, inclusive (YYYY-MM-DD)'),
    keyword: z.string().optional().describe('Filter to models whose title contains this text'),
  }),
  output: z.object({
    models: z.array(modelStatsSchema).describe('Per-model metrics for the requested range'),
    count: z.number().describe('Number of models returned'),
  }),
  handle: async params => {
    const data = await api<RawModelStatsList>('design-user-service', '/my/creatortools/design/list', {
      query: { startDate: params.start_date, endDate: params.end_date, keyword: params.keyword },
    });

    const models = (data.modelList ?? []).map(mapModelStats);
    return { models, count: models.length };
  },
});
