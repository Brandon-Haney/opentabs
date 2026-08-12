import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';

interface RawRedeemResult {
  redeemStatus?: number;
  redeemNeedAudit?: boolean;
  giftCardCode?: string;
  redeemNo?: string;
}

export const redeemProduct = defineTool({
  name: 'redeem_product',
  displayName: 'Redeem Product',
  description:
    'SPENDS POINTS IRREVERSIBLY. Exchanges your points for a point shop product such as a gift card or discount code. There is no refund and no undo — points are deducted immediately and MakerWorld does not reverse redemptions. Always confirm the exact product and its point cost with the user before calling this, and check get_points_summary to verify the balance covers it. Some products enter a multi-day review before the code is issued. Get the sku and product_type_id from list_shop_products.',
  summary: 'Spend points on a point shop product (irreversible)',
  icon: 'gift',
  group: 'Points',
  input: z.object({
    sku: z.string().min(1).describe('Product SKU from list_shop_products'),
    product_type_id: z.number().int().describe('Product type ID from list_shop_products, paired with the SKU'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the redemption was accepted'),
    status: z.number().describe('Redemption status code returned by MakerWorld'),
    needs_review: z.boolean().describe('Whether the redemption is held for manual review before the code is issued'),
    redeem_number: z.string().describe('Redemption reference, empty if not yet assigned'),
    gift_card_code: z.string().describe('Issued gift card code, empty when none was issued or review is pending'),
  }),
  handle: async params => {
    const result = await api<RawRedeemResult>('point-service', '/redeem', {
      method: 'POST',
      body: { sku: params.sku, productTypeId: params.product_type_id },
    });

    return {
      success: true,
      status: result.redeemStatus ?? 0,
      needs_review: result.redeemNeedAudit ?? false,
      redeem_number: result.redeemNo ?? '',
      gift_card_code: result.giftCardCode ?? '',
    };
  },
});
