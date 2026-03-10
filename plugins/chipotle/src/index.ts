import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './chipotle-api.js';
import { findRestaurants } from './tools/find-restaurants.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { getExtrasCampaigns } from './tools/get-extras-campaigns.js';
import { getFavorites } from './tools/get-favorites.js';
import { getLastRestaurant } from './tools/get-last-restaurant.js';
import { getLoyaltyPoints } from './tools/get-loyalty-points.js';
import { getMenu } from './tools/get-menu.js';
import { getMenuGroups } from './tools/get-menu-groups.js';
import { getOrderingStatus } from './tools/get-ordering-status.js';
import { getPaymentMethods } from './tools/get-payment-methods.js';
import { getPreconfiguredMeals } from './tools/get-preconfigured-meals.js';
import { getPromotions } from './tools/get-promotions.js';
import { getRecentOrders } from './tools/get-recent-orders.js';
import { getRewardCategories } from './tools/get-reward-categories.js';
import { getRewards } from './tools/get-rewards.js';
import { getRestaurant } from './tools/get-restaurant.js';

class ChipotlePlugin extends OpenTabsPlugin {
  readonly name = 'chipotle';
  readonly description = 'OpenTabs plugin for Chipotle Mexican Grill';
  override readonly displayName = 'Chipotle';
  readonly urlPatterns = ['*://*.chipotle.com/*'];
  override readonly homepage = 'https://www.chipotle.com';
  readonly tools: ToolDefinition[] = [
    getCurrentUser,
    getLoyaltyPoints,
    getPaymentMethods,
    getPromotions,
    getOrderingStatus,
    findRestaurants,
    getRestaurant,
    getMenu,
    getMenuGroups,
    getPreconfiguredMeals,
    getRecentOrders,
    getFavorites,
    getLastRestaurant,
    getRewards,
    getRewardCategories,
    getExtrasCampaigns,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new ChipotlePlugin();
