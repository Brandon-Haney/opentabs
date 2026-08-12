import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';

interface RawCashRedeem {
  exclusivePoint?: number;
  canRedeemAmount?: number;
  currency?: string;
  redeemMinAmount?: number;
  redeemMaxAmount?: number;
  reviewDays?: number;
  oneExclusivePointAmount?: number;
  exclusivePointThresholdMin?: number;
  exclusivePointThresholdMax?: number;
}

export const getCashRedemptionInfo = defineTool({
  name: 'get_cash_redemption_info',
  displayName: 'Get Cash Redemption Info',
  description:
    "Get the cash-out terms for exclusive points: the per-point cash rate, the cash value currently available, and the minimum and maximum payout amounts. Compare the per-point cash rate against a gift card's point cost from list_shop_products to work out which redemption route returns more value per point.",
  summary: 'Get the exclusive-point cash-out rate and limits',
  icon: 'banknote',
  group: 'Points',
  input: z.object({}),
  output: z.object({
    exclusive_points: z.number().describe('Exclusive points currently held'),
    available_cash: z.number().describe('Cash value of the current exclusive point balance'),
    currency: z.string().describe('Payout currency code'),
    rate_per_point: z.number().describe('Cash value of a single exclusive point'),
    min_payout: z.number().describe('Smallest permitted cash-out amount'),
    max_payout: z.number().describe('Largest permitted cash-out amount'),
    min_points_required: z.number().describe('Exclusive points needed to reach the minimum payout'),
    review_days: z.number().describe('Business days a cash-out request takes to review'),
  }),
  handle: async () => {
    const d = await api<RawCashRedeem>('point-service', '/cash-redeem/progress');

    return {
      exclusive_points: d.exclusivePoint ?? 0,
      available_cash: d.canRedeemAmount ?? 0,
      currency: d.currency ?? '',
      rate_per_point: d.oneExclusivePointAmount ?? 0,
      min_payout: d.redeemMinAmount ?? 0,
      max_payout: d.redeemMaxAmount ?? 0,
      min_points_required: d.exclusivePointThresholdMin ?? 0,
      review_days: d.reviewDays ?? 0,
    };
  },
});
