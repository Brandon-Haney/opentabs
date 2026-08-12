import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { earningsVelocitySchema, mapTransaction, type RawModelStats, type RawTransactionList } from './schemas.js';

/** Ledger entries per request while walking the whole income history. */
const LEDGER_PAGE_SIZE = 100;

/** Ceiling on ledger pages, so an implausible total cannot spin the loop forever. */
const MAX_LEDGER_PAGES = 200;

/** Start of the creator-dashboard query — earlier than any MakerWorld model. */
const DASHBOARD_EPOCH = '2020-01-01';

/**
 * Rating rewards name the model that was rated, which belongs to another
 * creator, so they are income but not income produced by this creator's models.
 */
const RATING_TYPE = 'create_rating';

/** Trailing window used for the "still earning" side of the comparison. */
const RECENT_WINDOW_DAYS = 30;

const MS_PER_DAY = 86_400_000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const toDayIndex = (isoDate: string): number => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY);

/** Points a model earned each calendar day, keyed YYYY-MM-DD. */
type DailyEarnings = Map<string, number>;

interface ModelEarnings {
  byDay: DailyEarnings;
  total: number;
  exclusive: number;
}

const classifyTrajectory = (momentum: number, recentPoints: number): 'growing' | 'steady' | 'fading' | 'dormant' => {
  if (recentPoints === 0) return 'dormant';
  if (momentum >= 1.1) return 'growing';
  if (momentum >= 0.5) return 'steady';
  return 'fading';
};

/**
 * Walk the whole income ledger and total each model's earnings by calendar day.
 *
 * Regular and exclusive points are summed rather than reading `points`, because
 * that field is the rounded figure MakerWorld displays while the two components
 * carry the fractional amounts actually credited.
 */
const collectEarningsByModel = async (
  onPage: (loaded: number, total: number) => void,
): Promise<Map<number, ModelEarnings>> => {
  const earnings = new Map<number, ModelEarnings>();
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  for (let page = 0; page < MAX_LEDGER_PAGES && offset < total; page++) {
    const data = await api<RawTransactionList>('point-service', '/point-bill/my', {
      query: { filter: 'incomes', offset, limit: LEDGER_PAGE_SIZE },
    });

    const hits = data.hits ?? [];
    total = data.total ?? hits.length;
    onPage(Math.min(offset + hits.length, total), total);
    if (hits.length === 0) break;

    for (const raw of hits) {
      const entry = mapTransaction(raw);
      if (entry.type === RATING_TYPE || entry.design_id === 0) continue;

      const day = entry.earned_for_date || entry.occurred_at.slice(0, 10);
      if (!day) continue;

      const model = earnings.get(entry.design_id) ?? { byDay: new Map(), total: 0, exclusive: 0 };
      const points = entry.regular_points + entry.exclusive_points;
      model.byDay.set(day, (model.byDay.get(day) ?? 0) + points);
      model.total += points;
      model.exclusive += entry.exclusive_points;
      earnings.set(entry.design_id, model);
    }

    offset += LEDGER_PAGE_SIZE;
  }

  return earnings;
};

const SORT_KEYS = ['launch_velocity', 'time_to_threshold', 'momentum', 'points_total', 'points_per_day'] as const;

type VelocityRow = z.infer<typeof earningsVelocitySchema>;

const compareBy = (sortBy: (typeof SORT_KEYS)[number]) => (a: VelocityRow, b: VelocityRow) => {
  switch (sortBy) {
    case 'time_to_threshold':
      // Models that never reached the threshold sort last rather than first.
      return (a.days_to_threshold ?? Number.POSITIVE_INFINITY) - (b.days_to_threshold ?? Number.POSITIVE_INFINITY);
    case 'momentum':
      return b.momentum - a.momentum;
    case 'points_total':
      return b.points_total - a.points_total;
    case 'points_per_day':
      return b.points_per_day_lifetime - a.points_per_day_lifetime;
    default:
      return b.points_in_launch_window - a.points_in_launch_window;
  }
};

export const analyzeEarningsVelocity = defineTool({
  name: 'analyze_earnings_velocity',
  displayName: 'Analyze Earnings Velocity',
  description:
    'Rank published models by how quickly they earned and whether they are still earning, which raw lifetime totals cannot show because older models have simply had longer to accumulate. Every model is measured from its own publication date: points earned inside the launch window, points in the first 90 days, days taken to reach a point threshold, and points earned in the last 30 days, plus a momentum figure comparing the recent daily rate against the lifetime rate. Use it to tell a model that opened strongly and then went quiet from one that still earns every day, and so to decide which designs are worth iterating on. Reports points, not currency — convert with the rate from get_cash_redemption_info or a gift card price from list_shop_products.',
  summary: 'Rank models by earning speed and current momentum',
  icon: 'trending-up',
  group: 'Analytics',
  input: z.object({
    launch_window_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Days after publication that count as the launch window (default 30)'),
    threshold_points: z
      .number()
      .min(1)
      .optional()
      .describe('Cumulative points a model must reach for days_to_threshold (default 250)'),
    sort_by: z.enum(SORT_KEYS).optional().describe('Ranking to apply (default "launch_velocity")'),
    limit: z.number().int().min(1).max(100).optional().describe('Models to return (default 20)'),
  }),
  output: z.object({
    models: z.array(earningsVelocitySchema).describe('Ranked models, best first for the chosen sort'),
    count: z.number().describe('Number of models returned'),
    launch_window_days: z.number().describe('Launch window the figures were computed against'),
    threshold_points: z.number().describe('Threshold days_to_threshold was measured against'),
  }),
  handle: async (params, context) => {
    const launchWindowDays = params.launch_window_days ?? 30;
    const thresholdPoints = params.threshold_points ?? 250;
    const sortBy = params.sort_by ?? 'launch_velocity';
    const limit = params.limit ?? 20;

    const today = new Date().toISOString().slice(0, 10);
    const todayIndex = toDayIndex(today);

    context?.reportProgress({ progress: 0, total: 2, message: 'Reading model performance…' });
    const stats = await api<{ modelList?: RawModelStats[] }>('design-user-service', '/my/creatortools/design/list', {
      query: { startDate: DASHBOARD_EPOCH, endDate: today },
    });

    const earnings = await collectEarningsByModel((loaded, total) =>
      context?.reportProgress({ progress: 1, total: 2, message: `Reading point ledger — ${loaded} of ${total}…` }),
    );

    const models: VelocityRow[] = (stats.modelList ?? []).map(raw => {
      const designId = raw.designId ?? 0;
      const publishedAt = (raw.publishTime ?? '').slice(0, 10);
      const model = earnings.get(designId) ?? { byDay: new Map<string, number>(), total: 0, exclusive: 0 };
      const impressions = raw.impression ?? 0;

      const publishIndex = publishedAt ? toDayIndex(publishedAt) : todayIndex;
      const ageDays = Math.max(1, todayIndex - publishIndex);

      let launchPoints = 0;
      let first90Points = 0;
      let recentPoints = 0;
      for (const [day, points] of model.byDay) {
        const sincePublish = toDayIndex(day) - publishIndex;
        if (sincePublish >= 0 && sincePublish < launchWindowDays) launchPoints += points;
        if (sincePublish >= 0 && sincePublish < 90) first90Points += points;
        if (todayIndex - toDayIndex(day) < RECENT_WINDOW_DAYS) recentPoints += points;
      }

      // Walk days in order and note when the running total first clears the threshold.
      let cumulative = 0;
      let daysToThreshold: number | null = null;
      for (const day of [...model.byDay.keys()].sort()) {
        cumulative += model.byDay.get(day) ?? 0;
        if (cumulative >= thresholdPoints) {
          daysToThreshold = Math.max(0, toDayIndex(day) - publishIndex);
          break;
        }
      }

      const lifetimeRate = model.total / ageDays;
      const momentum = lifetimeRate > 0 ? recentPoints / RECENT_WINDOW_DAYS / lifetimeRate : 0;

      return {
        design_id: designId,
        title: raw.title ?? '',
        published_at: publishedAt,
        age_days: ageDays,
        points_total: round2(model.total),
        points_in_launch_window: round2(launchPoints),
        points_first_90_days: round2(first90Points),
        points_last_30_days: round2(recentPoints),
        points_per_day_lifetime: round2(lifetimeRate),
        days_to_threshold: daysToThreshold,
        momentum: round2(momentum),
        trajectory: classifyTrajectory(momentum, recentPoints),
        earns_exclusive_points: model.exclusive > 0,
        prints: raw.print ?? 0,
        impressions,
        points_per_1k_impressions: impressions > 0 ? round2((model.total / impressions) * 1000) : 0,
      };
    });

    models.sort(compareBy(sortBy));
    const ranked = models.slice(0, limit);

    return {
      models: ranked,
      count: ranked.length,
      launch_window_days: launchWindowDays,
      threshold_points: thresholdPoints,
    };
  },
});
