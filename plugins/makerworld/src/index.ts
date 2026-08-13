import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ConfigSchema, ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './makerworld-api.js';
import { analyzeEarningsVelocity } from './tools/analyze-earnings-velocity.js';
import { deleteDraft } from './tools/delete-draft.js';
import { diagnoseListing } from './tools/diagnose-listing.js';
import { getAnalyticsTimeseries } from './tools/get-analytics-timeseries.js';
import { getCashRedemptionInfo } from './tools/get-cash-redemption-info.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { getModel } from './tools/get-model.js';
import { getPointsProgress } from './tools/get-points-progress.js';
import { getPointsSummary } from './tools/get-points-summary.js';
import { getPrintProfiles } from './tools/get-print-profiles.js';
import { listCategories } from './tools/list-categories.js';
import { listDrafts } from './tools/list-drafts.js';
import { listLicenses } from './tools/list-licenses.js';
import { listModelFeedback } from './tools/list-model-feedback.js';
import { listModelStats } from './tools/list-model-stats.js';
import { listMyModels } from './tools/list-my-models.js';
import { listNotifications } from './tools/list-notifications.js';
import { listPrinters } from './tools/list-printers.js';
import { listProfileStats } from './tools/list-profile-stats.js';
import { listRedemptions } from './tools/list-redemptions.js';
import { listShopProducts } from './tools/list-shop-products.js';
import { listShops } from './tools/list-shops.js';
import { listTransactions } from './tools/list-transactions.js';
import { publishDraft } from './tools/publish-draft.js';
import { redeemProduct } from './tools/redeem-product.js';
import { setModelVisibility } from './tools/set-model-visibility.js';
import { setPrinterCompatibility } from './tools/set-printer-compatibility.js';
import { suggestTags } from './tools/suggest-tags.js';
import { updateModel } from './tools/update-model.js';
import { updateProfile } from './tools/update-profile.js';
import { uploadModel } from './tools/upload-model.js';

class MakerWorldPlugin extends OpenTabsPlugin {
  readonly name = 'makerworld';
  readonly description = 'OpenTabs plugin for MakerWorld';
  override readonly displayName = 'MakerWorld';
  readonly urlPatterns = ['*://makerworld.com/*', '*://*.makerworld.com/*'];
  override readonly homepage = 'https://makerworld.com';
  override readonly configSchema: ConfigSchema = {
    printers: {
      type: 'string',
      label: 'My printers',
      description:
        'Printers you want your models offered for, comma separated — product names such as "X1 Carbon, P1S, A1 mini" or device codes such as "BL-P001, C12, N1". set_printer_compatibility narrows to this set when called without an explicit list, and get_print_profiles reports which of these a profile fails to cover. Leave empty to treat every printer MakerWorld checks as equally relevant.',
      placeholder: 'X1 Carbon, P1S, A1, A1 mini',
    },
  };
  readonly tools: ToolDefinition[] = [
    // Points
    getPointsSummary,
    getPointsProgress,
    listTransactions,
    listShops,
    listShopProducts,
    listRedemptions,
    getCashRedemptionInfo,
    redeemProduct,
    // Analytics
    listModelStats,
    listProfileStats,
    getAnalyticsTimeseries,
    analyzeEarningsVelocity,
    diagnoseListing,
    listModelFeedback,
    // Models
    listMyModels,
    getModel,
    getPrintProfiles,
    setPrinterCompatibility,
    updateModel,
    suggestTags,
    setModelVisibility,
    // Uploads
    uploadModel,
    listDrafts,
    publishDraft,
    deleteDraft,
    // Account
    getCurrentUser,
    updateProfile,
    listNotifications,
    // Reference
    listLicenses,
    listCategories,
    listPrinters,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new MakerWorldPlugin();
