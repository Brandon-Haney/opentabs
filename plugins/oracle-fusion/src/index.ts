import type { ConfigSchema, ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { getPageGlobal, OpenTabsPlugin, waitUntil } from '@opentabs-dev/plugin-sdk';
import { INVENTORY_WORK_AREA_SETTING, INVENTORY_WORK_AREA_SETTING_LABEL } from './inventory.js';
import { PURCHASE_ORDERS_WORK_AREA_SETTING, PURCHASE_ORDERS_WORK_AREA_SETTING_LABEL } from './procurement.js';
import { getItemQuantities } from './tools/get-item-quantities.js';
import { searchCompletedTransactions } from './tools/search-completed-transactions.js';
import { searchExpectedShipments } from './tools/search-expected-shipments.js';
import { searchMovementRequests } from './tools/search-movement-requests.js';
import { searchPendingTransactions } from './tools/search-pending-transactions.js';
import { searchPurchaseOrders } from './tools/search-purchase-orders.js';

/**
 * A classic Fusion page boots the ADF client only for a signed-in session — the sign-in
 * form is served by a separate identity host — so its presence marks a usable tab.
 */
const isSignedIn = (): boolean => getPageGlobal('AdfPage.PAGE') !== undefined;

class OracleFusionPlugin extends OpenTabsPlugin {
  readonly name = 'oracle-fusion';
  readonly description = 'OpenTabs plugin for Oracle Fusion Cloud Applications';
  override readonly displayName = 'Oracle Fusion';
  readonly urlPatterns = ['*://*.oraclecloud.com/fscmUI/*'];
  override readonly configSchema: ConfigSchema = {
    instanceUrl: {
      type: 'url' as const,
      label: 'Instance URL',
      description:
        'The URL of your Oracle Fusion instance if it uses a custom domain (e.g., https://erp.example.com). ' +
        'Leave empty for standard *.oraclecloud.com instances.',
      required: false,
      placeholder: 'https://erp.example.com',
    },
    [INVENTORY_WORK_AREA_SETTING]: {
      type: 'string' as const,
      label: INVENTORY_WORK_AREA_SETTING_LABEL,
      description:
        'Label of the home page tile that opens the Inventory Management work area. Set this when your ' +
        'organization has renamed the tile. Defaults to Inventory Management.',
      required: false,
      placeholder: 'Inventory Management',
    },
    [PURCHASE_ORDERS_WORK_AREA_SETTING]: {
      type: 'string' as const,
      label: PURCHASE_ORDERS_WORK_AREA_SETTING_LABEL,
      description:
        'Label of the home page tile that opens the Purchase Orders work area. Set this when your organization ' +
        'has renamed the tile. Defaults to Purchase Orders.',
      required: false,
      placeholder: 'Purchase Orders',
    },
  };
  readonly tools: ToolDefinition[] = [
    getItemQuantities,
    searchCompletedTransactions,
    searchExpectedShipments,
    searchMovementRequests,
    searchPendingTransactions,
    searchPurchaseOrders,
  ];

  async isReady(): Promise<boolean> {
    if (isSignedIn()) return true;
    try {
      await waitUntil(isSignedIn, { interval: 500, timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

export default new OracleFusionPlugin();
