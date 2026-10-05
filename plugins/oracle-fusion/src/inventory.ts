import { getConfig } from '@opentabs-dev/plugin-sdk';

/** Plugin setting that names the home page tile of the Inventory Management work area. */
export const INVENTORY_WORK_AREA_SETTING = 'inventoryWorkArea';
export const INVENTORY_WORK_AREA_SETTING_LABEL = 'Inventory work area';

const DEFAULT_INVENTORY_WORK_AREA = 'Inventory Management';

/** Tasks panel category that lists the work area's inventory tasks. */
export const INVENTORY_TASKS = 'Inventory';

/** Tasks panel category that lists the work area's receiving tasks. */
export const RECEIPTS_TASKS = 'Receipts';

/**
 * Label of the home page tile that opens the Inventory Management work area. Organizations
 * rename and regroup home page tiles, so the label is a setting with Oracle's name as the default.
 */
export const inventoryWorkArea = (): string => {
  const configured = getConfig(INVENTORY_WORK_AREA_SETTING);
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : DEFAULT_INVENTORY_WORK_AREA;
};
