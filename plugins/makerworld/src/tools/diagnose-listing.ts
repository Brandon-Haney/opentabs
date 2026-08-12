import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { listingDiagnosisSchema, type RawModelStats } from './schemas.js';

/** Start of the creator-dashboard query — earlier than any MakerWorld model. */
const DASHBOARD_EPOCH = '2020-01-01';

/**
 * Benchmark percentile every model is measured against.
 *
 * The median is too soft a target to be worth acting on and the maximum is
 * usually a one-off, so the upper quartile stands in for "as good as this
 * catalogue is known to get".
 */
const BENCHMARK_PERCENTILE = 0.75;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const ratio = (numerator: number, denominator: number): number => (denominator > 0 ? numerator / denominator : 0);

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction));
  return sorted[index] ?? 0;
};

interface Funnel {
  stats: RawModelStats;
  impressions: number;
  views: number;
  prints: number;
  points: number;
  viewRate: number;
  printRate: number;
  pointsPerPrint: number;
}

const toFunnel = (stats: RawModelStats): Funnel => {
  const impressions = stats.impression ?? 0;
  const views = stats.view ?? 0;
  const prints = stats.print ?? 0;
  const points = stats.point ?? 0;
  return {
    stats,
    impressions,
    views,
    prints,
    points,
    viewRate: ratio(views, impressions),
    printRate: ratio(prints, views),
    pointsPerPrint: ratio(points, prints),
  };
};

export const diagnoseListing = defineTool({
  name: 'diagnose_listing',
  displayName: 'Diagnose Listings',
  description:
    'Break every model down into its conversion funnel and size, in points, what a better listing could be worth. Impressions to views is close to a pure measure of the title and cover image, since that is all a browsing user sees before clicking; views to prints measures the page itself — description, photos, print profiles. Each model is compared against the upper quartile of your own catalogue and the shortfall is carried through the rest of its funnel, which is what makes the estimate meaningful: a poor click-through rate on a model nobody prints is worth almost nothing, while a small shortfall on a model with heavy traffic and strong print conversion is worth a great deal. Ranking by any single rate instead will point at the wrong models. Pair it with list_model_feedback to find out whether a weak page is a wording problem or a design problem, and with get_model to read the current title, tags, and description.',
  summary: 'Find where listings lose traffic and what fixing them is worth',
  icon: 'search-check',
  group: 'Analytics',
  input: z.object({
    design_id: z
      .number()
      .int()
      .optional()
      .describe('Restrict the report to one model. Benchmarks are still computed across the whole catalogue.'),
    limit: z.number().int().min(1).max(100).optional().describe('Models to return (default 20)'),
  }),
  output: z.object({
    models: z.array(listingDiagnosisSchema).describe('Models ranked by total modelled opportunity, largest first'),
    count: z.number().describe('Number of models returned'),
    benchmark_view_rate: z.number().describe('Upper-quartile views per 100 impressions across the catalogue'),
    benchmark_print_rate: z.number().describe('Upper-quartile prints per 100 views across the catalogue'),
    total_opportunity_points: z.number().describe('Modelled opportunity summed over the returned models'),
  }),
  handle: async params => {
    const today = new Date().toISOString().slice(0, 10);
    const data = await api<{ modelList?: RawModelStats[] }>('design-user-service', '/my/creatortools/design/list', {
      query: { startDate: DASHBOARD_EPOCH, endDate: today },
    });

    const funnels = (data.modelList ?? []).map(toFunnel);

    // Benchmarks come from models with enough traffic to have a meaningful rate;
    // a model with a handful of impressions would otherwise distort the quartile.
    const rated = funnels.filter(funnel => funnel.impressions > 0 && funnel.views > 0);
    const benchmarkViewRate = percentile(
      rated.map(funnel => funnel.viewRate),
      BENCHMARK_PERCENTILE,
    );
    const benchmarkPrintRate = percentile(
      rated.map(funnel => funnel.printRate),
      BENCHMARK_PERCENTILE,
    );

    const diagnosed = funnels.map(funnel => {
      // Lifting the click-through rate adds views, which convert and earn at this
      // model's own existing rates — a shortfall only matters if the traffic it
      // unlocks goes on to print.
      const extraViews = Math.max(0, benchmarkViewRate - funnel.viewRate) * funnel.impressions;
      const cardOpportunity = extraViews * funnel.printRate * funnel.pointsPerPrint;

      // Lifting the print rate converts views the model already receives, but a
      // page rewrite cannot change what the object is. A low print rate is as
      // often narrow demand — a mount for one specific car — as it is a weak
      // page, and the two are indistinguishable from the metrics alone. Cap the
      // modelled gain at the prints the design has already proven it can draw,
      // so a wide gap on an unproven niche cannot outrank a modest gap on a
      // design with demonstrated demand. Read the feedback before acting on it.
      const rawExtraPrints = Math.max(0, benchmarkPrintRate - funnel.printRate) * funnel.views;
      const extraPrints = Math.min(rawExtraPrints, funnel.prints);
      const pageOpportunity = extraPrints * funnel.pointsPerPrint;

      const bottleneck =
        cardOpportunity < 1 && pageOpportunity < 1 ? 'none' : cardOpportunity >= pageOpportunity ? 'card' : 'page';

      return {
        design_id: funnel.stats.designId ?? 0,
        title: funnel.stats.title ?? '',
        impressions: funnel.impressions,
        views: funnel.views,
        prints: funnel.prints,
        points: round2(funnel.points),
        view_rate: round2(funnel.viewRate * 100),
        print_rate: round2(funnel.printRate * 100),
        points_per_print: round2(funnel.pointsPerPrint),
        card_opportunity_points: round2(cardOpportunity),
        page_opportunity_points: round2(pageOpportunity),
        opportunity_points: round2(cardOpportunity + pageOpportunity),
        bottleneck: bottleneck as 'card' | 'page' | 'none',
      };
    });

    const selected =
      params.design_id === undefined
        ? diagnosed.sort((a, b) => b.opportunity_points - a.opportunity_points).slice(0, params.limit ?? 20)
        : diagnosed.filter(model => model.design_id === params.design_id);

    return {
      models: selected,
      count: selected.length,
      benchmark_view_rate: round2(benchmarkViewRate * 100),
      benchmark_print_rate: round2(benchmarkPrintRate * 100),
      total_opportunity_points: round2(selected.reduce((sum, model) => sum + model.opportunity_points, 0)),
    };
  },
});
