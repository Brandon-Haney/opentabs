import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import type { MakerWorldList } from './schemas.js';

interface RawShop {
  name?: string;
  displayName?: string;
  currency?: string;
  countries?: string[] | null;
}

export const listShops = defineTool({
  name: 'list_shops',
  displayName: 'List Point Shop Stores',
  description:
    "List the regional stores whose catalogs points can be redeemed against, with each store's currency and the countries it serves. Call this before list_shop_products to get a valid store name.",
  summary: 'List regional point shop stores',
  icon: 'store',
  group: 'Points',
  input: z.object({}),
  output: z.object({
    shops: z
      .array(
        z.object({
          name: z.string().describe('Store identifier to pass to list_shop_products'),
          display_name: z.string().describe('Human-readable store name'),
          currency: z.string().describe('Store currency code (e.g., USD)'),
          countries: z.array(z.string()).describe('Countries this store serves'),
        }),
      )
      .describe('Available stores'),
  }),
  handle: async () => {
    const data = await api<MakerWorldList<RawShop>>('point-service', '/product/shops');

    return {
      shops: (data.hits ?? []).map(s => ({
        name: s.name ?? '',
        display_name: s.displayName ?? '',
        currency: s.currency ?? '',
        countries: s.countries ?? [],
      })),
    };
  },
});
