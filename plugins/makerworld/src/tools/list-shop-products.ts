import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { type MakerWorldList, mapShopProduct, type RawShopProduct, shopProductSchema } from './schemas.js';

export const listShopProducts = defineTool({
  name: 'list_shop_products',
  displayName: 'List Point Shop Products',
  description:
    "List everything redeemable in the point shop for a store, with each item's cost in points. Use this to find redemption targets and their thresholds — for example, the point cost of a gift card — and combine it with get_points_summary and list_transactions to project when a balance will reach a given item. Call list_shops first to discover valid store names.",
  summary: 'List point shop products and their point costs',
  icon: 'shopping-bag',
  group: 'Points',
  input: z.object({
    shop: z.string().min(1).describe('Store name as returned by list_shops (e.g., "USA", "EU")'),
    product_type_id: z.number().int().optional().describe('Filter to a single product type; omit to return every type'),
    search: z
      .string()
      .optional()
      .describe('Case-insensitive substring match against the product title (e.g., "gift card")'),
    offset: z.number().int().min(0).optional().describe('Number of products to skip (default 0)'),
    limit: z.number().int().min(1).max(100).optional().describe('Products per page (default 25, max 100)'),
  }),
  output: z.object({
    products: z.array(shopProductSchema).describe('Redeemable products for the requested page'),
    total: z.number().describe('Number of products matching the filters, before paging'),
  }),
  handle: async params => {
    // The endpoint ignores paging and filtering parameters and always returns the
    // store's full catalog (roughly 190 items), so both are applied here.
    const data = await api<MakerWorldList<RawShopProduct>>('point-service', '/product/products', {
      query: { shopName: params.shop },
    });

    let products = (data.hits ?? []).map(mapShopProduct);

    if (params.product_type_id !== undefined) {
      products = products.filter(p => p.product_type_id === params.product_type_id);
    }
    if (params.search) {
      const needle = params.search.toLowerCase();
      products = products.filter(p => p.title.toLowerCase().includes(needle));
    }

    const offset = params.offset ?? 0;
    const limit = params.limit ?? 25;

    return {
      products: products.slice(offset, offset + limit),
      total: products.length,
    };
  },
});
