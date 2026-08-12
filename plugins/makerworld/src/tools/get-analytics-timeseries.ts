import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchPageData } from '../makerworld-api.js';
import {
  mapPeriodStats,
  mapStatsTotals,
  periodStatsSchema,
  type RawPeriodStats,
  type RawStatsTotals,
  statsTotalsSchema,
} from './schemas.js';

interface RawStatisticalData {
  /** Present on account-wide and per-model pages */
  designInfo?: { title?: string };
  /** Present on per-print-profile pages */
  instBaseInfo?: { title?: string };
  summary?: RawStatsTotals;
  dateList?: RawPeriodStats[];
  weekList?: RawPeriodStats[];
  monthList?: RawPeriodStats[];
  yearList?: RawPeriodStats[];
}

/**
 * The four analytics pages agree on the payload shape but not on the property
 * holding it — per-model pages use `modelData`, the rest use `statisticalData`.
 */
interface RawAnalyticsPage {
  statisticalData?: RawStatisticalData;
  modelData?: RawStatisticalData;
}

/** MakerWorld pre-aggregates the series at four granularities; pick the matching list. */
const SERIES_KEY = {
  day: 'dateList',
  week: 'weekList',
  month: 'monthList',
  year: 'yearList',
} as const;

export const getAnalyticsTimeseries = defineTool({
  name: 'get_analytics_timeseries',
  displayName: 'Get Analytics Time Series',
  description:
    'Get a metric series over time plus totals for the range — impressions, views, followers, likes, collects, prints, downloads, points, and boosts, with points broken out by model versus print profile. Without an ID this covers the whole account, which is the tool for trend, seasonality, and growth-rate questions; with design_id or instance_id it returns the series for that one model or print profile. Because it reports points per period, it is the basis for projecting when a balance will reach a redemption threshold. Use granularity to control resolution — prefer week or month over long ranges, since day returns one row per day.',
  summary: 'Metric series over time for the account, a model, or a profile',
  icon: 'trending-up',
  group: 'Analytics',
  input: z.object({
    start_date: z.string().describe('Start of the range, inclusive (YYYY-MM-DD)'),
    end_date: z.string().describe('End of the range, inclusive (YYYY-MM-DD)'),
    granularity: z
      .enum(['day', 'week', 'month', 'year'])
      .optional()
      .describe('Resolution of the series (default "day")'),
    design_id: z
      .number()
      .int()
      .optional()
      .describe('Restrict the series to one model; mutually exclusive with instance_id'),
    instance_id: z
      .number()
      .int()
      .optional()
      .describe('Restrict the series to one print profile; mutually exclusive with design_id'),
    scope: z
      .enum(['models', 'print_profiles'])
      .optional()
      .describe('Which account-wide series to return when neither ID is given: "models" (default) or "print_profiles"'),
  }),
  output: z.object({
    title: z.string().describe('Title of the model or profile, empty for account-wide series'),
    granularity: z.string().describe('Resolution the series was returned at'),
    totals: statsTotalsSchema.describe('Aggregate metrics across the whole range'),
    series: z.array(periodStatsSchema).describe('One entry per period, oldest first'),
  }),
  handle: async params => {
    if (params.design_id !== undefined && params.instance_id !== undefined) {
      throw ToolError.validation('Pass design_id or instance_id, not both.');
    }

    let route: string;
    if (params.design_id !== undefined) {
      route = `/my/data-overview/model/${params.design_id}`;
    } else if (params.instance_id !== undefined) {
      route = `/my/data-overview/printProfile/${params.instance_id}`;
    } else {
      route = params.scope === 'print_profiles' ? '/my/data-overview/printProfile' : '/my/data-overview/model';
    }

    const page = await fetchPageData<RawAnalyticsPage>(route, {
      startDate: params.start_date,
      endDate: params.end_date,
    });

    const stats = page.statisticalData ?? page.modelData;
    if (!stats) {
      throw ToolError.notFound('MakerWorld returned no analytics for that range.');
    }

    const granularity = params.granularity ?? 'day';
    const series = stats[SERIES_KEY[granularity]] ?? [];

    return {
      title: stats.designInfo?.title ?? stats.instBaseInfo?.title ?? '',
      granularity,
      totals: mapStatsTotals(stats.summary ?? {}),
      series: series.map(mapPeriodStats),
    };
  },
});
