import { getConfig } from '@opentabs-dev/plugin-sdk';
import type { Criterion } from './search-page.js';

/** Plugin setting that names the home page tile of the Purchase Orders work area. */
export const PURCHASE_ORDERS_WORK_AREA_SETTING = 'purchaseOrdersWorkArea';
export const PURCHASE_ORDERS_WORK_AREA_SETTING_LABEL = 'Purchase Orders work area';

const DEFAULT_PURCHASE_ORDERS_WORK_AREA = 'Purchase Orders';

/**
 * Label of the home page tile that opens the Purchase Orders work area. Organizations rename
 * and regroup home page tiles, so the label is a setting with Oracle's name as the default.
 */
export const purchaseOrdersWorkArea = (): string => {
  const configured = getConfig(PURCHASE_ORDERS_WORK_AREA_SETTING);
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : DEFAULT_PURCHASE_ORDERS_WORK_AREA;
};

/** What a Manage Orders search asks for; each criterion left out matches anything. */
export interface PurchaseOrderSearch {
  order?: string;
  keywords?: string;
  supplier?: string;
  requisition?: string;
  /** Order status, exactly as the Status dropdown lists it. */
  status?: string;
  /** Whether closed orders are searched too (default true). */
  includeClosed?: boolean;
}

/**
 * Criteria of one Manage Orders search. Every field is sent, so a value left over from an
 * earlier search in the same window is cleared. The page fills Buyer with the signed-in
 * user, which would hide every other buyer's orders, so Buyer is always cleared.
 */
export const purchaseOrderCriteria = (search: PurchaseOrderSearch): Criterion[] => [
  { label: 'Keywords', text: search.keywords ?? '' },
  { label: 'Supplier', text: search.supplier ?? '' },
  { label: 'Buyer', text: '' },
  { label: 'Order', text: search.order ?? '' },
  { label: 'Requisition', text: search.requisition ?? '' },
  { label: 'Status', option: search.status ?? '' },
  { label: 'Include Closed Documents', option: search.includeClosed === false ? 'No' : 'Yes' },
];
