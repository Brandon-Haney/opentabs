import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { type MakerWorldList, mapModelSummary, modelSummarySchema, type RawModelSummary } from './schemas.js';

export const listMyModels = defineTool({
  name: 'list_my_models',
  displayName: 'List My Models',
  description:
    'List your published models with lifetime totals for likes, collects, prints, downloads, and comments. These are all-time counts — use list_model_stats when the question is about a specific date range. Returns model IDs needed by get_model, update_model, and the analytics tools.',
  summary: 'List your published models with lifetime totals',
  icon: 'box',
  group: 'Models',
  input: z.object({
    offset: z.number().int().min(0).optional().describe('Number of models to skip (default 0)'),
    limit: z.number().int().min(1).max(100).optional().describe('Models per page (default 20, max 100)'),
  }),
  output: z.object({
    models: z.array(modelSummarySchema).describe('Your published models'),
    total: z.number().describe('Total number of published models'),
  }),
  handle: async params => {
    const data = await api<MakerWorldList<RawModelSummary>>('design-service', '/my/design/published', {
      query: { offset: params.offset ?? 0, limit: params.limit ?? 20 },
    });

    return {
      models: (data.hits ?? []).map(mapModelSummary),
      total: data.total ?? 0,
    };
  },
});
