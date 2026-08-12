import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { mapPointsSummary, pointsSummarySchema, type RawPointsSummary } from './schemas.js';

export const getPointsSummary = defineTool({
  name: 'get_points_summary',
  displayName: 'Get Points Summary',
  description:
    'Get the current point balance, split into regular and exclusive points, plus boost token holdings. Exclusive points are the ones that can be redeemed for cash and gift cards; regular points can only be spent in the point shop. Use this as the starting point for any balance, budgeting, or redemption-forecasting question.',
  summary: 'Get the current point balance',
  icon: 'coins',
  group: 'Points',
  input: z.object({}),
  output: z.object({ summary: pointsSummarySchema.describe('Current point and boost balances') }),
  handle: async () => {
    const data = await api<RawPointsSummary>('point-service', '/summary');
    return { summary: mapPointsSummary(data) };
  },
});
