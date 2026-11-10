import { INVENTORY_WORK_AREA_SETTING_LABEL, inventoryWorkArea, RECEIPTS_TASKS } from './inventory.js';
import { renderedRows } from './results.js';
import type { Criterion } from './search-page.js';
import { createSearchScreen, isUnknownValue, type LookupField, type SearchRejectedError } from './search-screen.js';

/**
 * Receive Expected Shipments, in the Receipts tasks of Inventory Management: every line the
 * store expects to receive and has not received yet. One background window serves every tool
 * that searches it.
 */
export const expectedShipmentsScreen = createSearchScreen({
  workArea: inventoryWorkArea,
  workAreaSetting: INVENTORY_WORK_AREA_SETTING_LABEL,
  category: RECEIPTS_TASKS,
  task: 'Receive Expected Shipments',
  // The results table sits in the page's table toolbar; the other tables belong to lookups.
  results: renderedRows(/:_ATp:[^:]+$/),
});

/**
 * Document fields of the page, keyed by tool parameter: the label each has on the page, and
 * the label its lookup dialog gives the document number.
 */
export const EXPECTED_SHIPMENT_DOCUMENTS = {
  purchase_order: { label: 'Purchase Order', lookupLabel: 'Purchase Order' },
  asn: { label: 'ASN', lookupLabel: 'Shipment' },
  transfer_order: { label: 'Transfer Order', lookupLabel: 'Transfer Order' },
  in_transit_shipment: { label: 'In-Transit Shipment', lookupLabel: 'Shipment' },
  rma: { label: 'RMA', lookupLabel: 'RMA' },
} as const satisfies Record<string, LookupField>;

export type ExpectedShipmentDocument = keyof typeof EXPECTED_SHIPMENT_DOCUMENTS;

/** Criteria besides the document numbers; each left out matches anything. */
export interface ExpectedShipmentFilters {
  supplier?: string;
  item?: string;
  /** Due date range, exactly as the page lists it, such as "All past due". */
  dueDate?: string;
}

/**
 * Criteria of one search. Every field is sent, so a value left over from an earlier search
 * in the same window is cleared.
 */
export const expectedShipmentCriteria = (
  documents: Partial<Record<ExpectedShipmentDocument, string>>,
  filters: ExpectedShipmentFilters = {},
): Criterion[] => [
  ...(Object.entries(EXPECTED_SHIPMENT_DOCUMENTS) as [ExpectedShipmentDocument, LookupField][]).map(
    ([field, { label }]) => ({ label, text: documents[field] ?? '' }),
  ),
  { label: 'Supplier', text: filters.supplier ?? '' },
  { label: 'Item', text: filters.item ?? '' },
  { label: 'Due Date', option: filters.dueDate ?? '' },
];

/**
 * Reads which of the named document fields Fusion refused because it does not know the
 * number. Returns null when Fusion refused the search for any other reason, which the tool
 * reports as an error.
 */
export const unknownDocuments = (
  error: SearchRejectedError,
  named: ExpectedShipmentDocument[],
): Set<ExpectedShipmentDocument> | null => {
  const unknown = new Set<ExpectedShipmentDocument>();
  for (const message of error.messages) {
    const field = named.find(candidate => EXPECTED_SHIPMENT_DOCUMENTS[candidate].label === message.field);
    if (!field || !isUnknownValue(message)) return null;
    unknown.add(field);
  }
  return unknown.size > 0 ? unknown : null;
};
