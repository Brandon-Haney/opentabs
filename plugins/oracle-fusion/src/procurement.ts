import { getConfig } from '@opentabs-dev/plugin-sdk';

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
