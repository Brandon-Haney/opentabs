/**
 * Shared Zod output schemas, raw API interfaces, and defensive mappers.
 *
 * Every entity the plugin returns is defined once here: the clean shape sent to
 * the agent, the raw shape MakerWorld actually sends (all fields optional), and
 * a mapper that bridges them with `??` defaults so a changed or partial API
 * response degrades instead of throwing.
 */

import { z } from 'zod';

// --- Paginated envelope -------------------------------------------------------

/** MakerWorld's standard list envelope. */
export interface MakerWorldList<T> {
  total?: number;
  hits?: T[];
}

// --- Points -------------------------------------------------------------------

export const pointsSummarySchema = z.object({
  total_points: z
    .number()
    .describe(
      'Total point balance as MakerWorld reports it, truncated to a whole number. Add regular_points and exclusive_points for the exact fractional balance.',
    ),
  regular_points: z.number().describe('Regular points — usable in the point shop but not redeemable for cash'),
  exclusive_points: z
    .number()
    .describe('Exclusive points — earned from exclusive models, redeemable for cash and gift cards'),
  total_boosts: z.number().describe('Unspent boost tokens held'),
  boost_income: z.number().describe('Total boosts received from other users, all time'),
  boost_exchange_rate: z.number().describe('Points received when converting one boost token to points'),
});

export interface RawPointsSummary {
  userTotalPoint?: number;
  userTotalRegularPoint?: number;
  userTotalExclusivePoint?: number;
  userTotalBoost?: number;
  userTotalBoostIncomes?: number;
  oneBoostExchangePoint?: number;
}

export const mapPointsSummary = (s: RawPointsSummary) => ({
  total_points: s.userTotalPoint ?? 0,
  regular_points: s.userTotalRegularPoint ?? 0,
  exclusive_points: s.userTotalExclusivePoint ?? 0,
  total_boosts: s.userTotalBoost ?? 0,
  boost_income: s.userTotalBoostIncomes ?? 0,
  boost_exchange_rate: s.oneBoostExchangePoint ?? 0,
});

export const transactionSchema = z.object({
  type: z
    .string()
    .describe('Transaction type (e.g., design_reward_v2, instance_reward_v2, boost_exchange_point, redeem)'),
  points: z.number().describe('Point change — positive for income, negative for spending'),
  regular_points: z.number().describe('Portion of the change that was regular points'),
  exclusive_points: z.number().describe('Portion of the change that was exclusive points'),
  is_exclusive_bonus: z.boolean().describe('Whether this transaction earned the exclusive-model bonus rate'),
  occurred_at: z.string().describe('ISO 8601 timestamp of the transaction'),
  earned_for_date: z
    .string()
    .describe('Calendar date (YYYY-MM-DD) whose activity produced this reward, empty when not applicable'),
  design_id: z
    .number()
    .describe(
      'Model ID this transaction relates to, 0 when not model-related. On create_rating rows it identifies the model that was rated, which belongs to another creator, so exclude that type when totalling earnings per owned model.',
    ),
  design_title: z.string().describe('Model title this transaction relates to, empty when not model-related'),
  instance_id: z.number().describe('Print profile ID this transaction relates to, 0 when not profile-related'),
  instance_title: z.string().describe('Print profile title, empty when not profile-related'),
  sync_source: z.string().describe('Originating site for cross-region rewards (e.g., "CN"), empty for the main site'),
});

interface RawRewardDetail {
  id?: number;
  designId?: number;
  designTitle?: number | string;
  title?: string;
  instanceId?: number;
  instanceTitle?: string;
  earningTime?: string;
}

export interface RawTransaction {
  type?: string;
  pointChange?: number;
  pointChangeRegular?: number;
  pointChangeExclusive?: number;
  isExclusiveBonus?: boolean;
  pointTime?: string;
  syncSource?: string;
  designRewardV2?: RawRewardDetail;
  instanceRewardV2?: RawRewardDetail;
  designReward?: RawRewardDetail;
  instanceReward?: RawRewardDetail;
  design?: RawRewardDetail;
  pointRating?: RawRewardDetail;
  extInfoBoostExchangePoint?: RawRewardDetail;
}

/**
 * Reward details live under a different key per transaction type, and the model
 * identifier is `id` on model-level rewards but `designId` on profile, rating,
 * and boost rewards. Normalise all of that into one flat shape.
 *
 * Both generations of the reward payload appear in a mature ledger: the current
 * `designRewardV2`/`instanceRewardV2` keys and the original
 * `designReward`/`instanceReward` pair the API still returns for older entries.
 * Reading only the V2 keys silently drops model attribution for every reward
 * earned before the payload changed.
 */
export const mapTransaction = (t: RawTransaction) => {
  const modelDetail = t.designRewardV2 ?? t.designReward ?? t.design;
  const detail: RawRewardDetail =
    modelDetail ?? t.instanceRewardV2 ?? t.instanceReward ?? t.pointRating ?? t.extInfoBoostExchangePoint ?? {};
  const designTitle = modelDetail?.title ?? detail.designTitle;

  return {
    type: t.type ?? '',
    points: t.pointChange ?? 0,
    regular_points: t.pointChangeRegular ?? 0,
    exclusive_points: t.pointChangeExclusive ?? 0,
    is_exclusive_bonus: t.isExclusiveBonus ?? false,
    occurred_at: t.pointTime ?? '',
    earned_for_date: detail.earningTime ?? '',
    design_id: modelDetail?.id ?? detail.designId ?? 0,
    design_title: typeof designTitle === 'string' ? designTitle : '',
    instance_id: detail.instanceId ?? 0,
    instance_title: detail.instanceTitle ?? '',
    sync_source: t.syncSource ?? '',
  };
};

/** One page of the point ledger, plus the lifetime totals it always carries. */
export interface RawTransactionList {
  total?: number;
  totalIncome?: number;
  totalExpense?: number;
  totalRegularIncome?: number;
  totalRegularExpense?: number;
  totalExclusiveIncome?: number;
  totalExclusiveExpense?: number;
  hits?: RawTransaction[];
}

export const earningsVelocitySchema = z.object({
  design_id: z.number().describe('Model ID'),
  title: z.string().describe('Model title'),
  published_at: z.string().describe('Publication date (YYYY-MM-DD)'),
  age_days: z.number().describe('Days between publication and today'),
  points_total: z.number().describe('Every point the ledger credits to this model, boost tips and bonuses included'),
  points_in_launch_window: z
    .number()
    .describe('Points earned within launch_window_days of publication — the age-neutral measure of a strong launch'),
  points_first_90_days: z.number().describe('Points earned within 90 days of publication'),
  points_last_30_days: z.number().describe('Points earned in the last 30 days — what the model earns now'),
  points_per_day_lifetime: z.number().describe('points_total divided by age_days'),
  days_to_threshold: z
    .number()
    .nullable()
    .describe('Days from publication until cumulative earnings reached threshold_points, null if never reached'),
  momentum: z
    .number()
    .describe(
      'Recent daily rate divided by lifetime daily rate. Above 1 the model is earning faster than its own average, below 1 it is slowing.',
    ),
  trajectory: z
    .enum(['growing', 'steady', 'fading', 'dormant'])
    .describe(
      'Plain reading of momentum: growing >= 1.1, steady >= 0.5, fading below that, dormant when nothing came in',
    ),
  earns_exclusive_points: z
    .boolean()
    .describe('Whether this model has ever earned exclusive points, which indicates exclusive-program membership'),
  prints: z.number().describe('Lifetime prints'),
  impressions: z.number().describe('Lifetime impressions'),
  points_per_1k_impressions: z.number().describe('Points earned per thousand impressions — how well reach converts'),
});

// --- Feedback -----------------------------------------------------------------

const feedbackReplySchema = z.object({
  author: z.string().describe('Display name of the replier'),
  content: z.string().describe('Reply text'),
  created_at: z.string().describe('ISO 8601 timestamp'),
  like_count: z.number().describe('Likes on the reply'),
});

export const modelFeedbackSchema = z.object({
  kind: z.enum(['comment', 'rating']).describe('A plain comment, or a rating that carries a score'),
  id: z.number().describe('Feedback entry ID'),
  content: z.string().describe('What was written'),
  author: z.string().describe('Display name of the author'),
  author_handle: z.string().describe('Profile handle of the author'),
  created_at: z.string().describe('ISO 8601 timestamp'),
  score: z.number().describe('Star rating from 1 to 5, or 0 on a plain comment'),
  printed_successfully: z.boolean().describe('Whether the rater reported a successful print'),
  issues: z
    .array(z.string())
    .describe('Problem categories the rater selected on a low score, such as "Support Issue" — empty otherwise'),
  like_count: z.number().describe('Likes received'),
  reply_count: z.number().describe('Replies received'),
  image_count: z.number().describe('Photos attached, which usually indicates a real print'),
  instance_id: z.number().describe('Print profile the rating applies to, 0 for comments'),
  replies: z.array(feedbackReplySchema).describe('Replies carried inline, where the API supplies them'),
});

interface RawFeedbackUser {
  name?: string;
  handle?: string;
}

interface RawFeedbackReply {
  content?: string;
  createTime?: string;
  likeCount?: number;
  creator?: RawFeedbackUser;
}

interface RawLowScoreDetail {
  reason?: string;
}

interface RawFeedbackRating {
  id?: number;
  content?: string;
  createTime?: string;
  score?: number;
  likeCount?: number;
  replyCount?: number;
  images?: string[];
  instanceId?: number;
  successPrinted?: boolean;
  lowScoreDetails?: RawLowScoreDetail[];
  instRatingReply?: RawFeedbackReply[];
  creator?: RawFeedbackUser;
}

interface RawFeedbackComment {
  id?: number;
  content?: string;
  createTime?: string;
  likeCount?: number;
  replyCount?: number;
  images?: string[];
  user?: RawFeedbackUser;
}

export interface RawFeedbackEntry {
  type?: number;
  ratingItem?: RawFeedbackRating;
  comment?: RawFeedbackComment;
}

/** Feed entries tagged with this type carry a rating; anything else is a comment. */
const FEEDBACK_TYPE_RATING = 2;

/**
 * Flatten one entry of the combined comment-and-rating feed.
 *
 * The endpoint interleaves two different records under one list: plain comments
 * arrive under `comment` with a `user`, while ratings arrive under `ratingItem`
 * with a `creator`, a score, and — on low scores — the structured problem
 * categories the rater picked. Ratings also carry their replies inline, which
 * comments do not.
 */
export const mapFeedbackEntry = (entry: RawFeedbackEntry) => {
  const rating = entry.type === FEEDBACK_TYPE_RATING ? entry.ratingItem : undefined;
  const comment = rating ? undefined : entry.comment;
  const author = rating?.creator ?? comment?.user;
  const source = rating ?? comment;

  return {
    kind: (rating ? 'rating' : 'comment') as 'comment' | 'rating',
    id: source?.id ?? 0,
    content: source?.content ?? '',
    author: author?.name ?? '',
    author_handle: author?.handle ?? '',
    created_at: source?.createTime ?? '',
    score: rating?.score ?? 0,
    printed_successfully: rating?.successPrinted ?? false,
    issues: (rating?.lowScoreDetails ?? []).map(detail => detail.reason ?? '').filter(reason => reason.length > 0),
    like_count: source?.likeCount ?? 0,
    reply_count: source?.replyCount ?? 0,
    image_count: (source?.images ?? []).length,
    instance_id: rating?.instanceId ?? 0,
    replies: (rating?.instRatingReply ?? []).map(reply => ({
      author: reply.creator?.name ?? '',
      content: reply.content ?? '',
      created_at: reply.createTime ?? '',
      like_count: reply.likeCount ?? 0,
    })),
  };
};

// --- Print profiles ------------------------------------------------------------

export const printProfileDetailSchema = z.object({
  instance_id: z.number().describe('Print profile ID'),
  title: z.string().describe('Profile title, e.g. "0.2mm layer, 2 walls, 15% infill"'),
  supported_printers: z
    .array(z.string())
    .describe('Printers this profile was sliced against and can be printed on, primary included'),
  unsupported_printers: z
    .array(z.string())
    .describe(
      'Printers MakerWorld checks that this profile does not cover. Usually models released after the profile was uploaded, whose owners are silently unable to print it — republishing the model re-runs the check and picks them up.',
    ),
  nozzle_mm: z.number().describe('Nozzle diameter the profile was sliced for'),
  print_time_minutes: z.number().describe('Estimated print time'),
  filament_grams: z.number().describe('Estimated filament use'),
  plate_count: z.number().describe('Build plates the profile spans — more than one is extra work for the printer'),
  needs_ams: z.boolean().describe('Whether an AMS is required, which excludes anyone without one'),
  prints: z.number().describe('Prints recorded against this profile'),
  downloads: z.number().describe('Downloads of this profile'),
  rating_count: z.number().describe('Ratings received'),
  average_rating: z.number().describe('Mean star rating, 0 when unrated'),
});

interface RawPrinter {
  devProductName?: string;
  nozzleDiameter?: number;
}

interface RawInstanceModelInfo {
  compatibility?: RawPrinter;
  otherCompatibility?: RawPrinter[];
  plates?: unknown[];
}

interface RawInstance {
  id?: number;
  title?: string;
  weight?: number;
  prediction?: number;
  needAms?: boolean;
  printCount?: number;
  downloadCount?: number;
  ratingCount?: number;
  ratingScoreTotal?: number;
  extention?: { modelInfo?: RawInstanceModelInfo };
}

/**
 * A design together with its print profiles.
 *
 * Printer compatibility is nested at `instances[].extention.modelInfo` rather
 * than on the instance itself, and is absent from the dedicated instances
 * endpoint, so the plain design payload is the only reliable source for it.
 */
export interface RawDesignWithInstances {
  title?: string;
  instances?: RawInstance[];
}

/** One entry of MakerWorld's printer fleet, as the profile editor supplies it. */
export interface RawMachine {
  devModelName?: string;
  devProductName?: string;
  model?: string;
  name?: string;
}

/**
 * A print profile draft, plus the fleet and derived compatibility around it.
 *
 * `detail.otherCompatibility` is what MakerWorld derived by slicing the 3MF and
 * is read-only in practice — writing it is accepted into the draft and then
 * discarded on publish. `detail.unsupportedDevModels` is the author's opt-out
 * list and is the only field that actually changes what gets published.
 */
export interface RawProfileEditPage {
  detail?: {
    id?: number;
    instanceId?: number;
    compatibility?: RawPrinter;
    otherCompatibility?: RawPrinter[];
    unsupportedDevModels?: string[];
    details?: string[];
    [field: string]: unknown;
  };
  machines?: RawMachine[];
}

// --- Listing diagnosis ---------------------------------------------------------

export const listingDiagnosisSchema = z.object({
  design_id: z.number().describe('Model ID'),
  title: z.string().describe('Model title'),
  impressions: z.number().describe('Times the model card was shown'),
  views: z.number().describe('Times the card was clicked through to the page'),
  prints: z.number().describe('Prints recorded'),
  points: z.number().describe('Performance points earned, excluding boost tips'),
  view_rate: z.number().describe('Views per 100 impressions — how well the title and cover image sell the click'),
  print_rate: z.number().describe('Prints per 100 views — how well the page itself converts an interested visitor'),
  points_per_print: z.number().describe('Points earned per print'),
  card_opportunity_points: z
    .number()
    .describe('Modelled points gained if view_rate rose to the catalogue 75th percentile, holding everything else'),
  page_opportunity_points: z
    .number()
    .describe(
      'Modelled points gained if print_rate rose to the catalogue 75th percentile, capped at doubling the prints the design has already drawn. The cap matters: a very low print rate is as often narrow demand as a weak page, so an uncapped figure would rank unproven niches above proven designs.',
    ),
  opportunity_points: z.number().describe('card_opportunity_points plus page_opportunity_points'),
  bottleneck: z
    .enum(['card', 'page', 'none'])
    .describe(
      'Where the larger modelled gain sits: "card" points at the title and cover image, "page" at the description, photos, and print profiles, "none" when the model already beats both benchmarks',
    ),
});

export const shopProductSchema = z.object({
  sku: z.string().describe('Product SKU — pass this to redeem_product'),
  title: z.string().describe('Product name'),
  price: z.number().describe('Cost in points'),
  product_type_id: z.number().describe('Product type ID — pass this to redeem_product alongside the SKU'),
  currency: z.string().describe('Currency of the associated store (e.g., USD)'),
  shop: z.string().describe('Store identifier the product belongs to (e.g., bambulab-us)'),
  description: z.string().describe('Product description including redemption restrictions'),
  in_stock: z.boolean().describe('Whether the product is currently redeemable'),
  gift_card_value: z.number().describe('Face value in the store currency for gift cards, 0 for other product types'),
});

export interface RawShopProduct {
  sku?: string;
  title?: string;
  price?: number;
  productTypeId?: number;
  description?: string;
  inventoryAvailable?: boolean;
  shop?: { name?: string; currency?: string };
  giftcard?: { value?: number } | null;
  selfBuiltGiftcard?: { value?: number } | null;
}

export const mapShopProduct = (p: RawShopProduct) => ({
  sku: p.sku ?? '',
  title: p.title ?? '',
  price: p.price ?? 0,
  product_type_id: p.productTypeId ?? 0,
  currency: p.shop?.currency ?? '',
  shop: p.shop?.name ?? '',
  description: p.description ?? '',
  in_stock: p.inventoryAvailable ?? false,
  gift_card_value: p.giftcard?.value ?? p.selfBuiltGiftcard?.value ?? 0,
});

export const redemptionSchema = z.object({
  id: z.number().describe('Redemption ID'),
  redeem_number: z.string().describe('Human-readable redemption reference'),
  title: z.string().describe('Redeemed product name'),
  cost: z.number().describe('Points spent'),
  regular_points_spent: z.number().describe('Regular points spent'),
  exclusive_points_spent: z.number().describe('Exclusive points spent'),
  status: z.number().describe('Redemption status code (2 = completed)'),
  sku: z.string().describe('Redeemed product SKU'),
  shop: z.string().describe('Store the redemption applies to'),
  created_at: z.string().describe('ISO 8601 timestamp of the redemption'),
});

export interface RawRedemption {
  id?: number;
  redeemNo?: string;
  title?: string;
  cost?: number;
  costRegularPoint?: number;
  costExclusivePoint?: number;
  redeemStatus?: number;
  sku?: string;
  shop?: { name?: string };
  createTime?: string;
}

export const mapRedemption = (r: RawRedemption) => ({
  id: r.id ?? 0,
  redeem_number: r.redeemNo ?? '',
  title: r.title ?? '',
  cost: r.cost ?? 0,
  regular_points_spent: r.costRegularPoint ?? 0,
  exclusive_points_spent: r.costExclusivePoint ?? 0,
  status: r.redeemStatus ?? 0,
  sku: r.sku ?? '',
  shop: r.shop?.name ?? '',
  created_at: r.createTime ?? '',
});

// --- Analytics ----------------------------------------------------------------

export const modelStatsSchema = z.object({
  design_id: z.number().describe('Model ID'),
  title: z.string().describe('Model title'),
  published_at: z.string().describe('ISO 8601 publish timestamp'),
  impressions: z.number().describe('Times the model appeared in a feed or search result in the period'),
  views: z.number().describe('Model page views in the period'),
  likes: z.number().describe('Likes gained in the period'),
  collects: z.number().describe('Times collected in the period'),
  prints: z.number().describe('Prints recorded in the period'),
  downloads: z.number().describe('Downloads in the period'),
  points: z.number().describe('Points earned by this model in the period'),
  boosts: z.number().describe('Boosts received in the period'),
});

export interface RawModelStats {
  designId?: number;
  title?: string;
  publishTime?: string;
  impression?: number;
  view?: number;
  like?: number;
  collect?: number;
  print?: number;
  download?: number;
  point?: number;
  boost?: number;
}

export const mapModelStats = (m: RawModelStats) => ({
  design_id: m.designId ?? 0,
  title: m.title ?? '',
  published_at: m.publishTime ?? '',
  impressions: m.impression ?? 0,
  views: m.view ?? 0,
  likes: m.like ?? 0,
  collects: m.collect ?? 0,
  prints: m.print ?? 0,
  downloads: m.download ?? 0,
  points: m.point ?? 0,
  boosts: m.boost ?? 0,
});

export const profileStatsSchema = z.object({
  instance_id: z.number().describe('Print profile ID'),
  design_id: z.number().describe('Parent model ID'),
  design_title: z.string().describe('Parent model title'),
  title: z.string().describe('Print profile title (e.g., "0.2mm layer, 2 walls, 15% infill")'),
  published_at: z.string().describe('ISO 8601 publish timestamp'),
  prints: z.number().describe('Prints recorded in the period'),
  downloads: z.number().describe('Downloads in the period'),
  points: z.number().describe('Points earned by this profile in the period'),
  ratings: z.number().describe('Total ratings received'),
});

export interface RawProfileStats {
  id?: number;
  designId?: number;
  designTitle?: string;
  title?: string;
  publishTime?: string;
  print?: number;
  download?: number;
  point?: number;
  rated?: number;
}

export const mapProfileStats = (p: RawProfileStats) => ({
  instance_id: p.id ?? 0,
  design_id: p.designId ?? 0,
  design_title: p.designTitle ?? '',
  title: p.title ?? '',
  published_at: p.publishTime ?? '',
  prints: p.print ?? 0,
  downloads: p.download ?? 0,
  points: p.point ?? 0,
  ratings: p.rated ?? 0,
});

export const periodStatsSchema = z.object({
  period: z.string().describe('Period label — a date for daily granularity, otherwise the week, month, or year'),
  impressions: z.number().describe('Impressions in this period'),
  views: z.number().describe('Views in this period'),
  followers: z.number().describe('Followers gained in this period'),
  likes: z.number().describe('Likes gained in this period'),
  collects: z.number().describe('Collects in this period'),
  prints: z.number().describe('Prints in this period'),
  downloads: z.number().describe('Downloads in this period'),
  points: z.number().describe('Total points earned in this period, across all sources'),
  points_from_models: z
    .number()
    .describe('Points from model rewards. Always 0 on a print-profile series, which reports only a combined total.'),
  points_from_profiles: z
    .number()
    .describe(
      'Points from print profile rewards. Always 0 on a print-profile series, which reports only a combined total.',
    ),
  boosts: z.number().describe('Boosts received in this period'),
});

export interface RawPeriodStats {
  intervalVal?: string;
  impression?: number;
  view?: number;
  follower?: number;
  like?: number;
  collect?: number;
  print?: number;
  download?: number;
  /** Flat total, used by the print-profile series */
  point?: number;
  /** Per-source split, used by the account-wide and per-model series */
  pointFromModel?: number;
  pointFromInst?: number;
  pointFromOthers?: number;
  pointFromRatings?: number;
  boost?: number;
}

/**
 * Build a period row.
 *
 * The model series reports points split by source with no combined field, while
 * the print-profile series reports a flat `point` and no split. Prefer the flat
 * field when present and otherwise sum the parts, so `points` is comparable
 * across both and matches the totals the same response reports.
 */
export const mapPeriodStats = (d: RawPeriodStats) => {
  const fromModels = d.pointFromModel ?? 0;
  const fromProfiles = d.pointFromInst ?? 0;
  const summedPoints = fromModels + fromProfiles + (d.pointFromOthers ?? 0) + (d.pointFromRatings ?? 0);

  return {
    period: d.intervalVal ?? '',
    impressions: d.impression ?? 0,
    views: d.view ?? 0,
    followers: d.follower ?? 0,
    likes: d.like ?? 0,
    collects: d.collect ?? 0,
    prints: d.print ?? 0,
    downloads: d.download ?? 0,
    points: d.point ?? summedPoints,
    points_from_models: fromModels,
    points_from_profiles: fromProfiles,
    boosts: d.boost ?? 0,
  };
};

export const statsTotalsSchema = z.object({
  impressions: z.number().describe('Total impressions in the period'),
  views: z.number().describe('Total views in the period'),
  followers: z.number().describe('Followers gained in the period'),
  likes: z.number().describe('Likes gained in the period'),
  collects: z.number().describe('Collects in the period'),
  prints: z.number().describe('Prints in the period'),
  downloads: z.number().describe('Downloads in the period'),
  points: z.number().describe('Total points earned in the period'),
  points_from_models: z.number().describe('Points earned from model rewards'),
  points_from_profiles: z.number().describe('Points earned from print profile rewards'),
  boosts: z.number().describe('Boosts received in the period'),
});

export interface RawStatsTotals {
  impression?: number;
  view?: number;
  follower?: number;
  like?: number;
  collect?: number;
  print?: number;
  download?: number;
  point?: number;
  pointFromModel?: number;
  pointFromInst?: number;
  boost?: number;
}

export const mapStatsTotals = (s: RawStatsTotals) => ({
  impressions: s.impression ?? 0,
  views: s.view ?? 0,
  followers: s.follower ?? 0,
  likes: s.like ?? 0,
  collects: s.collect ?? 0,
  prints: s.print ?? 0,
  downloads: s.download ?? 0,
  points: s.point ?? 0,
  points_from_models: s.pointFromModel ?? 0,
  points_from_profiles: s.pointFromInst ?? 0,
  boosts: s.boost ?? 0,
});

// --- Models -------------------------------------------------------------------

export const modelSummarySchema = z.object({
  id: z.number().describe('Model ID'),
  title: z.string().describe('Model title'),
  slug: z.string().describe('URL slug'),
  url: z.string().describe('Public model page URL'),
  cover_url: z.string().describe('Cover image URL'),
  likes: z.number().describe('Lifetime like count'),
  collects: z.number().describe('Lifetime collect count'),
  prints: z.number().describe('Lifetime print count'),
  downloads: z.number().describe('Lifetime download count'),
  comments: z.number().describe('Comment count'),
  tags: z.array(z.string()).describe('Tags applied to the model'),
  print_profile_count: z.number().describe('Number of published print profiles'),
});

export interface RawModelSummary {
  id?: number;
  title?: string;
  slug?: string;
  coverUrl?: string;
  likeCount?: number;
  collectionCount?: number;
  printCount?: number;
  downloadCount?: number;
  commentCount?: number;
  tags?: string[];
  instances?: unknown[];
}

/** Build the public model page URL. MakerWorld tolerates a missing slug. */
const modelUrl = (id: number, slug: string): string =>
  id === 0 ? '' : `https://makerworld.com/en/models/${id}${slug ? `-${slug}` : ''}`;

export const mapModelSummary = (m: RawModelSummary) => {
  const id = m.id ?? 0;
  const slug = m.slug ?? '';
  return {
    id,
    title: m.title ?? '',
    slug,
    url: modelUrl(id, slug),
    cover_url: m.coverUrl ?? '',
    likes: m.likeCount ?? 0,
    collects: m.collectionCount ?? 0,
    prints: m.printCount ?? 0,
    downloads: m.downloadCount ?? 0,
    comments: m.commentCount ?? 0,
    tags: m.tags ?? [],
    print_profile_count: m.instances?.length ?? 0,
  };
};

export const modelDetailSchema = modelSummarySchema.extend({
  summary: z.string().describe('Model description as HTML'),
  license: z.string().describe('License identifier (e.g., BY-NC, BY-SA)'),
  nsfw: z.boolean().describe('Whether the model is flagged not-safe-for-work'),
  is_exclusive: z.boolean().describe('Whether the model is enrolled in the exclusive-model program'),
  status: z.number().describe('Publication status code (1 = published)'),
  created_at: z.string().describe('ISO 8601 creation timestamp'),
  updated_at: z.string().describe('ISO 8601 last-update timestamp'),
  category_id: z.number().describe('Category ID the model is filed under'),
  print_profiles: z
    .array(
      z.object({
        id: z.number().describe('Print profile ID'),
        title: z.string().describe('Print profile title'),
      }),
    )
    .describe('Published print profiles for this model'),
});

export interface RawModelDetail extends RawModelSummary {
  summary?: string;
  license?: string;
  nsfw?: boolean;
  isExclusive?: boolean;
  status?: number;
  createTime?: string;
  updateTime?: string;
  categories?: Array<{ id?: number }>;
  instances?: Array<{ id?: number; title?: string }>;
}

export const mapModelDetail = (m: RawModelDetail) => ({
  ...mapModelSummary(m),
  summary: m.summary ?? '',
  license: m.license ?? '',
  nsfw: m.nsfw ?? false,
  is_exclusive: m.isExclusive ?? false,
  status: m.status ?? 0,
  created_at: m.createTime ?? '',
  updated_at: m.updateTime ?? '',
  category_id: m.categories?.[0]?.id ?? 0,
  print_profiles: (m.instances ?? []).map(i => ({ id: i.id ?? 0, title: i.title ?? '' })),
});

// --- Account ------------------------------------------------------------------

export const userProfileSchema = z.object({
  uid: z.number().describe('Numeric user ID'),
  handle: z.string().describe('User handle (the @name in profile URLs)'),
  name: z.string().describe('Display name'),
  bio: z.string().describe('Profile bio text'),
  avatar_url: z.string().describe('Avatar image URL'),
  background_url: z.string().describe('Profile background image URL'),
  followers: z.number().describe('Follower count'),
  following: z.number().describe('Number of users followed'),
  total_likes: z.number().describe('Lifetime likes across all models'),
  total_collects: z.number().describe('Lifetime collects across all models'),
  total_downloads: z.number().describe('Lifetime downloads across all models'),
  printer_models: z.array(z.string()).describe('Printer models listed on the profile'),
  links: z.array(z.string()).describe('External links listed on the profile'),
  pinned_design_ids: z.array(z.number()).describe('Model IDs pinned to the profile'),
  default_license: z.string().describe('License applied to new uploads by default'),
  show_likes: z.boolean().describe('Whether other users can see the models you have liked'),
  show_followers: z.boolean().describe('Whether your follower list is public'),
  show_following: z.boolean().describe('Whether the list of users you follow is public'),
  show_nsfw: z.boolean().describe('Whether not-safe-for-work models are shown to you'),
});

export interface RawUserProfile {
  uid?: number;
  handle?: string;
  name?: string;
  bio?: string;
  avatar?: string;
  backgroundUrl?: string;
  fanCount?: number;
  followCount?: number;
  likeCount?: number;
  collectionCount?: number;
  downloadCount?: number;
  /** Short printer names, read-only view served by the profile endpoint */
  productModels?: string[];
  /** Full printer names, the writable field served by the preferences endpoint */
  deviceNames?: string[];
  links?: Array<string | { url?: string }>;
  pinnedDesignIds?: number[];
  defaultLicense?: string;
  /** Privacy switches, encoded as 0/1 integers rather than JSON booleans */
  isLikeOpen?: number;
  isFanOpen?: number;
  isFollowOpen?: number;
  isNSFWShown?: number;
  personal?: { bio?: string; links?: Array<string | { url?: string }>; backgroundUrl?: string; handle?: string };
}

/**
 * Build the public profile shape.
 *
 * Profile data is split across two endpoints and several fields exist in both
 * with different names and representations, so callers pass a merged document
 * (see `fetchFullProfile`). Printer models prefer `deviceNames` — the field
 * writes go to — so a read-after-write round-trips.
 */
export const mapUserProfile = (u: RawUserProfile) => ({
  uid: u.uid ?? 0,
  handle: u.handle ?? u.personal?.handle ?? '',
  name: u.name ?? '',
  bio: u.bio ?? u.personal?.bio ?? '',
  avatar_url: u.avatar ?? '',
  background_url: u.backgroundUrl ?? u.personal?.backgroundUrl ?? '',
  followers: u.fanCount ?? 0,
  following: u.followCount ?? 0,
  total_likes: u.likeCount ?? 0,
  total_collects: u.collectionCount ?? 0,
  total_downloads: u.downloadCount ?? 0,
  printer_models: u.deviceNames ?? u.productModels ?? [],
  links: (u.links ?? u.personal?.links ?? []).map(l => (typeof l === 'string' ? l : (l.url ?? ''))).filter(Boolean),
  pinned_design_ids: u.pinnedDesignIds ?? [],
  default_license: u.defaultLicense ?? '',
  show_likes: u.isLikeOpen === 1,
  show_followers: u.isFanOpen === 1,
  show_following: u.isFollowOpen === 1,
  show_nsfw: u.isNSFWShown === 1,
});
