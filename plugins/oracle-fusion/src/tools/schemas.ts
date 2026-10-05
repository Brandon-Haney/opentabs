import { z } from 'zod';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 200;

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe('Maximum rows to return (default 200, max 1000). Page with offset rather than raising it.');

export const offsetSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Number of rows to skip, for paging through a result larger than limit (default 0)');

export const totalSchema = z.number().int().describe('Total rows matching the search, across all pages');

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date formatted as YYYY-MM-DD');

/** Moves an ISO date (`YYYY-MM-DD`) by a number of days. */
export const shiftIsoDate = (isoDate: string, days: number): string => {
  const [year = 0, month = 1, day = 1] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Shared criteria
// ---------------------------------------------------------------------------

export const descriptionMatchSchema = z
  .enum(['starts_with', 'equals', 'contains'])
  .optional()
  .describe('How item_description is compared (default starts_with)');

/** Value a search page submits for each choice of its Item Description operator. */
export const DESCRIPTION_OPERATORS = { starts_with: 'STARTSWITH', equals: '=', contains: 'CONTAINS' } as const;

// ---------------------------------------------------------------------------
// Exported rows
// ---------------------------------------------------------------------------

/** One row of an exported results table, keyed by column heading. */
export type ExportedRow = Record<string, string>;

/** A numeric cell, falling back to 0 when empty or unparseable. Grouping separators are dropped. */
const num = (cell: string | undefined): number => {
  const parsed = Number((cell ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

// ---------------------------------------------------------------------------
// Completed inventory transactions
// ---------------------------------------------------------------------------

const TIMESTAMP_FORMAT = 'formatted YYYY-MM-DD HH:mm:ss in the time zone of the signed-in user’s Fusion preferences';

const ONLY_WITH_DETAILS = 'Present only when include_details is true.';

export const completedTransactionSchema = z.object({
  transaction_id: z.string().describe('Transaction number that identifies the inventory transaction'),
  item: z.string().describe('Item number'),
  item_description: z.string().describe('Item description'),
  subinventory: z.string().describe('Subinventory the transaction posted to'),
  locator: z.string().describe('Locator within the subinventory, empty when the subinventory has no locators'),
  transaction_quantity: z
    .number()
    .describe('Quantity moved, in transaction_uom. Negative for issues out of the subinventory, positive for receipts'),
  transaction_uom: z.string().describe('Unit of measure the transaction was entered in'),
  transaction_date: z.string().describe(`When the transaction took place, ${TIMESTAMP_FORMAT}`),
  source_type: z.string().describe('Transaction source type (e.g., Purchase Order, Sales Order, Inventory)'),
  source_reference: z
    .string()
    .describe('Document the transaction came from, such as a purchase order or sales order number; often empty'),
  creation_date: z.string().describe(`When the transaction record was created, ${TIMESTAMP_FORMAT}`),
  quantity: z
    .number()
    .describe('Value of the page’s Quantity column, expressed in uom_name; signed like transaction_quantity'),
  uom_name: z.string().describe('Unit of measure of the quantity field'),
  shipment: z.string().describe('Shipment number for receipts against an advance shipment notice, otherwise empty'),
  purchase_order: z.string().describe('Purchase order number for purchase order receipts, otherwise empty'),
  receipt: z.string().describe('Receipt number for receiving transactions, otherwise empty'),
  additional_columns: z
    .record(z.string(), z.string())
    .describe('Any further columns the user has added to the results table, keyed by column heading'),
});

/**
 * Fields only a completed transaction's detail page and About This Record dialog show. They
 * are present only when include_details is true; when present, an empty string means
 * Fusion has no value.
 */
export const completedTransactionDetailsSchema = z.object({
  transaction_type: z
    .string()
    .describe(`Transaction type (e.g., Subinventory Transfer, Miscellaneous Receipt). ${ONLY_WITH_DETAILS}`),
  transaction_action: z
    .string()
    .describe(`Transaction action (e.g., Subinventory transfer, Issue from stores). ${ONLY_WITH_DETAILS}`),
  reason: z
    .string()
    .describe(`Transaction reason, such as an adjustment reason; empty when none. ${ONLY_WITH_DETAILS}`),
  transfer_organization: z.string().describe(`Other organization of a transfer; empty otherwise. ${ONLY_WITH_DETAILS}`),
  transfer_subinventory: z.string().describe(`Other subinventory of a transfer; empty otherwise. ${ONLY_WITH_DETAILS}`),
  transfer_locator: z.string().describe(`Other locator of a transfer; empty otherwise. ${ONLY_WITH_DETAILS}`),
  transfer_transaction: z
    .string()
    .describe(`Transaction number of the other side of a transfer; empty otherwise. ${ONLY_WITH_DETAILS}`),
  created_by: z
    .string()
    .describe(`User who created the transaction, as Fusion shows it (often an employee number). ${ONLY_WITH_DETAILS}`),
  last_updated_by: z.string().describe(`User or process that last updated the transaction. ${ONLY_WITH_DETAILS}`),
  last_update_date: z
    .string()
    .describe(`When the transaction was last updated, as Fusion displays dates to the user. ${ONLY_WITH_DETAILS}`),
  details: z
    .record(z.string(), z.string())
    .describe(
      'Every field of the transaction’s detail page, keyed by the label Fusion shows (requester, source line, ' +
        `customer name, parent transaction and any fields your organization added). ${ONLY_WITH_DETAILS}`,
    ),
});

/** Maps the fields only a completed transaction's detail page and About This Record dialog show. */
export const mapCompletedTransactionDetails = (details: Record<string, string>, audit: Record<string, string>) => ({
  transaction_type: details['Transaction Type'] ?? '',
  transaction_action: details['Transaction Action'] ?? '',
  reason: details.Reason ?? '',
  transfer_organization: details['Transfer Organization'] ?? '',
  transfer_subinventory: details['Transfer Subinventory'] ?? '',
  transfer_locator: details['Transfer Locator'] ?? '',
  transfer_transaction: details['Transfer Transaction'] ?? '',
  created_by: audit['Created By'] ?? '',
  last_updated_by: audit['Last Updated By'] ?? '',
  last_update_date: audit['Last Update Date'] ?? '',
  details,
});

/** Column heading of each field on the Review Completed Transactions page. */
const COMPLETED_TRANSACTION_COLUMNS = {
  transaction_id: 'Transaction',
  item: 'Item',
  item_description: 'Item Description',
  subinventory: 'Subinventory',
  locator: 'Locator',
  transaction_quantity: 'Transaction Quantity',
  transaction_uom: 'Transaction UOM',
  transaction_date: 'Transaction Date',
  source_type: 'Transaction Source Type',
  source_reference: 'Source Reference',
  creation_date: 'Creation Date',
  quantity: 'Quantity',
  uom_name: 'UOM Name',
  shipment: 'Shipment',
  purchase_order: 'Purchase Order',
  receipt: 'Receipt',
} as const;

const KNOWN_COMPLETED_TRANSACTION_COLUMNS = new Set<string>(Object.values(COMPLETED_TRANSACTION_COLUMNS));

export const mapCompletedTransaction = (row: ExportedRow) => {
  const column = COMPLETED_TRANSACTION_COLUMNS;
  return {
    transaction_id: row[column.transaction_id] ?? '',
    item: row[column.item] ?? '',
    item_description: row[column.item_description] ?? '',
    subinventory: row[column.subinventory] ?? '',
    locator: row[column.locator] ?? '',
    transaction_quantity: num(row[column.transaction_quantity]),
    transaction_uom: row[column.transaction_uom] ?? '',
    transaction_date: row[column.transaction_date] ?? '',
    source_type: row[column.source_type] ?? '',
    source_reference: row[column.source_reference] ?? '',
    creation_date: row[column.creation_date] ?? '',
    quantity: num(row[column.quantity]),
    uom_name: row[column.uom_name] ?? '',
    shipment: row[column.shipment] ?? '',
    purchase_order: row[column.purchase_order] ?? '',
    receipt: row[column.receipt] ?? '',
    additional_columns: Object.fromEntries(
      Object.entries(row).filter(([heading]) => !KNOWN_COMPLETED_TRANSACTION_COLUMNS.has(heading)),
    ),
  };
};

// ---------------------------------------------------------------------------
// Pending inventory transactions
// ---------------------------------------------------------------------------

export const pendingTransactionSchema = z.object({
  transaction_id: z.string().describe('Transaction ID of the pending transaction'),
  processing_status: z
    .string()
    .describe(
      'Where the transaction is in processing (e.g., Error during processing, Ready to be processed, Awaiting approval)',
    ),
  process_status: z.string().describe('Whether the transaction is Staged or Validated'),
  error_explanation: z.string().describe('Why the transaction failed, as Fusion explains it; empty when it has not'),
  item: z.string().describe('Item number'),
  subinventory: z.string().describe('Subinventory the transaction takes from or posts to'),
  transaction_quantity: z.number().describe('Quantity, in uom. Negative for issues out of the subinventory'),
  uom: z.string().describe('Unit of measure of the quantity'),
  transaction_date: z
    .string()
    .describe('When the transaction was dated, formatted YYYY-MM-DD HH:mm:ss in the user’s Fusion time zone'),
  transaction_type: z.string().describe('Transaction type (e.g., Subinventory Transfer, Direct Sales Order Issue)'),
});

const ONLY_WITH_PENDING_DETAILS = 'Present only when include_details is not false.';

/**
 * Fields only a pending transaction's detail page shows. They are present only when the
 * details were read; when present, an empty string means Fusion has no value.
 */
export const pendingTransactionDetailsSchema = z.object({
  error_code: z
    .string()
    .describe(`Fusion error code; empty when the transaction has not failed. ${ONLY_WITH_PENDING_DETAILS}`),
  item_description: z.string().describe(`Item description. ${ONLY_WITH_PENDING_DETAILS}`),
  locator: z.string().describe(`Locator within the subinventory; empty when unset. ${ONLY_WITH_PENDING_DETAILS}`),
  destination_organization: z
    .string()
    .describe(`Receiving organization of a transfer; empty otherwise. ${ONLY_WITH_PENDING_DETAILS}`),
  destination_subinventory: z
    .string()
    .describe(`Receiving subinventory of a transfer; empty otherwise. ${ONLY_WITH_PENDING_DETAILS}`),
  destination_locator: z
    .string()
    .describe(`Receiving locator of a transfer; empty otherwise. ${ONLY_WITH_PENDING_DETAILS}`),
  transaction_action: z.string().describe(`Transaction action. ${ONLY_WITH_PENDING_DETAILS}`),
  source_type: z.string().describe(`Transaction source type. ${ONLY_WITH_PENDING_DETAILS}`),
  source_reference: z
    .string()
    .describe(`Document the transaction came from, such as a sales order number. ${ONLY_WITH_PENDING_DETAILS}`),
  reason: z.string().describe(`Transaction reason; empty when unset. ${ONLY_WITH_PENDING_DETAILS}`),
  details: z
    .record(z.string(), z.string())
    .describe(
      'Every field of the transaction’s detail page, keyed by the label Fusion shows, including any fields your ' +
        `organization added. ${ONLY_WITH_PENDING_DETAILS}`,
    ),
});

/** Column heading of each field in the Manage Pending Transactions export. */
const PENDING_TRANSACTION_COLUMNS = {
  transaction_id: 'Transaction ID',
  process_status: 'Transaction Process Status',
  item: 'Item',
  subinventory: 'Subinventory',
  transaction_quantity: 'Transaction Quantity',
  uom: 'Transaction UOM',
  transaction_date: 'Transaction Date',
  transaction_type: 'Transaction Type',
  processing_status: 'Processing Status',
  error_explanation: 'Error Explanation',
} as const;

/** Maps the columns of an exported row. */
export const mapPendingTransaction = (row: ExportedRow) => {
  const column = PENDING_TRANSACTION_COLUMNS;
  return {
    transaction_id: row[column.transaction_id] ?? '',
    processing_status: row[column.processing_status] ?? '',
    process_status: row[column.process_status] ?? '',
    error_explanation: row[column.error_explanation] ?? '',
    item: row[column.item] ?? '',
    subinventory: row[column.subinventory] ?? '',
    transaction_quantity: num(row[column.transaction_quantity]),
    uom: row[column.uom] ?? '',
    transaction_date: row[column.transaction_date] ?? '',
    transaction_type: row[column.transaction_type] ?? '',
  };
};

/** Maps the fields only a pending transaction's detail page shows. */
export const mapPendingTransactionDetails = (details: Record<string, string>) => ({
  error_code: details.Error ?? '',
  item_description: details['Item Description'] ?? '',
  locator: details.Locator ?? '',
  destination_organization: details['Destination Organization'] ?? '',
  destination_subinventory: details['Destination Subinventory'] ?? '',
  destination_locator: details['Destination Locator'] ?? '',
  transaction_action: details['Transaction Action'] ?? '',
  source_type: details['Source Type'] ?? '',
  source_reference: details['Source Reference'] ?? '',
  reason: details.Reason ?? '',
  details,
});

// ---------------------------------------------------------------------------
// Item quantities
// ---------------------------------------------------------------------------

/** A quantity cell, null when Fusion leaves it blank. Grouping separators are dropped. */
const quantity = (cell: string | undefined): number | null => {
  if (cell === undefined || cell === '') return null;
  const parsed = Number(cell.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const BLANK_QUANTITY = 'null when Fusion shows no value at this level';
const ONLY_WITH_AVAILABILITY = 'Present only when include_availability is true; null when Fusion shows no value.';

export const itemQuantitySchema = z.object({
  level: z
    .enum(['item', 'organization', 'subinventory', 'locator', 'other'])
    .describe(
      'Which level of the hierarchy the row totals: the whole item, one organization, one subinventory, or one ' +
        'locator. "other" is a level below locator, identified by name',
    ),
  name: z.string().describe('Value of the row at its own level, e.g. the subinventory code on a subinventory row'),
  item: z.string().describe('Item number'),
  item_description: z.string().describe('Item description'),
  organization: z.string().describe('Inventory organization code; empty on item rows'),
  subinventory: z.string().describe('Subinventory code; empty above subinventory level'),
  locator: z.string().describe('Locator; empty above locator level'),
  on_hand: z.number().nullable().describe(`Quantity on hand at this level, in uom. Can be negative. ${BLANK_QUANTITY}`),
  receiving: z.number().nullable().describe(`Quantity received but not yet put away, in uom; ${BLANK_QUANTITY}`),
  inbound: z.number().nullable().describe(`Quantity in transit to the organization, in uom; ${BLANK_QUANTITY}`),
  uom: z.string().describe('Unit of measure of the quantities'),
  available_to_transact: z
    .number()
    .nullable()
    .optional()
    .describe(
      'On-hand quantity at this level that can be transacted, from Fusion’s Item Availability; excludes stock ' +
        `in subinventories or statuses that block transactions. ${ONLY_WITH_AVAILABILITY}`,
    ),
  available_to_reserve: z
    .number()
    .nullable()
    .optional()
    .describe(
      'On-hand quantity at this level that can still be reserved for an order; on hand minus existing ' +
        `reservations and stock that cannot be reserved (e.g., picked or staged). ${ONLY_WITH_AVAILABILITY}`,
    ),
});

/** Level each node label starts with on the View Item Quantities page, outermost first. */
const QUANTITY_LEVELS = [
  ['Item', 'item'],
  ['Organization', 'organization'],
  ['Subinventory', 'subinventory'],
  ['Locator', 'locator'],
] as const;

type QuantityLevel = (typeof QUANTITY_LEVELS)[number][1] | 'other';

/** Splits a node label such as "Subinventory STORES" into its level and value. */
const parseQuantityNode = (label: string): { level: QuantityLevel; name: string } => {
  for (const [prefix, level] of QUANTITY_LEVELS) {
    if (label.startsWith(`${prefix} `)) return { level, name: label.slice(prefix.length + 1).trim() };
  }
  return { level: 'other', name: label };
};

/** A tree row of the View Item Quantities page, with its values keyed by column heading. */
export interface QuantityNode {
  label: string;
  /** Labels of the rows above this one, outermost first. */
  ancestorLabels: string[];
  values: ExportedRow;
  /** Description of the item the row belongs to, which Fusion shows on the item row only. */
  itemDescription: string;
  /** Item Availability of the row by quantity type, then by heading; absent when it was not read. */
  availability?: Record<string, Record<string, string>>;
}

export const mapItemQuantity = (node: QuantityNode) => {
  const own = parseQuantityNode(node.label);
  const path = [...node.ancestorLabels.map(parseQuantityNode), own];
  const at = (level: QuantityLevel): string => path.find(step => step.level === level)?.name ?? '';

  return {
    level: own.level,
    name: own.name,
    item: at('item'),
    item_description: node.itemDescription,
    organization: at('organization'),
    subinventory: at('subinventory'),
    locator: at('locator'),
    on_hand: quantity(node.values['On Hand']),
    receiving: quantity(node.values.Receiving),
    inbound: quantity(node.values.Inbound),
    uom: node.values['UOM Name'] ?? '',
    ...(node.availability && {
      available_to_transact: quantity(node.availability['Available to Transact']?.['On Hand']),
      available_to_reserve: quantity(node.availability['Available to Reserve']?.['On Hand']),
    }),
  };
};

// ---------------------------------------------------------------------------
// Expected shipments
// ---------------------------------------------------------------------------

export const expectedShipmentSchema = z.object({
  organization: z.string().describe('Inventory organization expecting the shipment'),
  item: z.string().describe('Item number'),
  item_description: z.string().describe('Item description'),
  document_number: z
    .string()
    .describe('Document the line belongs to: purchase order, RMA, transfer order or in-transit shipment number'),
  quantity: z.number().describe('Quantity still expected, in uom'),
  document_line: z.string().describe('Line number on the document'),
  document_schedule: z.string().describe('Schedule number of the line'),
  due_date: z.string().describe('When the line is due, as Fusion displays dates to the user (e.g., 10/24/25)'),
  uom: z.string().describe('Unit of measure of the quantity'),
});

/** Column heading of each field on the Receive Expected Shipments page. */
const EXPECTED_SHIPMENT_COLUMNS = {
  organization: 'Organization',
  item: 'Item',
  item_description: 'Item Description',
  document_number: 'Document Number',
  quantity: 'Quantity',
  document_line: 'Document Line',
  document_schedule: 'Document Schedule',
  due_date: 'Due Date',
  uom: 'UOM Name',
} as const;

export const mapExpectedShipment = (row: ExportedRow) => {
  const column = EXPECTED_SHIPMENT_COLUMNS;
  return {
    organization: row[column.organization] ?? '',
    item: row[column.item] ?? '',
    item_description: row[column.item_description] ?? '',
    document_number: row[column.document_number] ?? '',
    quantity: num(row[column.quantity]),
    document_line: row[column.document_line] ?? '',
    document_schedule: row[column.document_schedule] ?? '',
    due_date: row[column.due_date] ?? '',
    uom: row[column.uom] ?? '',
  };
};

// ---------------------------------------------------------------------------
// Movement requests
// ---------------------------------------------------------------------------

export const movementRequestLineSchema = z.object({
  movement_request: z.string().describe('Movement request number'),
  line_number: z.string().describe('Line number within the movement request'),
  movement_request_type: z.string().describe('Requisition, Replenishment, Pick wave, Shop floor or Recall'),
  transaction_type: z.string().describe('Transaction the line creates (e.g., Movement Request Transfer)'),
  item: z.string().describe('Item number'),
  item_description: z.string().describe('Item description'),
  requested_quantity: z.number().describe('Quantity requested, in uom'),
  delivered_quantity: z.number().describe('Quantity delivered so far, in uom'),
  uom: z.string().describe('Unit of measure of the quantities'),
  line_status: z.string().describe('Status of the line (e.g., Approved, Preapproved, Closed, Canceled)'),
  required_date: z.string().describe('When the line is required, as Fusion displays dates to the user'),
  source_subinventory: z.string().describe('Subinventory the material moves from; empty when unset'),
  source_locator: z.string().describe('Locator the material moves from; empty when unset'),
  destination_subinventory: z.string().describe('Subinventory the material moves to; empty when unset'),
  destination_locator: z.string().describe('Locator the material moves to; empty when unset'),
  reason: z.string().describe('Reason given for the line; empty when none'),
  requester: z.string().describe('Who requested the line; empty when unset'),
  store_invoice: z.string().describe('Store and invoice reference (the Store # - Invoice # field); empty when unset'),
  created_by: z.string().describe('User or integration that created the line'),
  additional_columns: z
    .record(z.string(), z.string())
    .describe('Every other column of the table (lot, project, ship-to location and so on), keyed by heading'),
});

/** Column heading of each field on the Manage Movement Requests page. */
const MOVEMENT_REQUEST_COLUMNS = {
  movement_request: 'Movement Request',
  line_number: 'Line Number',
  movement_request_type: 'Movement Request Type',
  transaction_type: 'Transaction Type',
  item: 'Item',
  item_description: 'Item Description',
  requested_quantity: 'Requested Quantity',
  delivered_quantity: 'Delivered Quantity',
  uom: 'UOM Name',
  line_status: 'Line Status',
  required_date: 'Required Date',
  source_subinventory: 'Source Subinventory',
  source_locator: 'Source Locator',
  destination_subinventory: 'Destination Subinventory',
  destination_locator: 'Destination Locator',
  reason: 'Reason',
  requester: 'Requester',
  store_invoice: 'Store # - Invoice #',
  created_by: 'Created By',
} as const;

const KNOWN_MOVEMENT_REQUEST_COLUMNS = new Set<string>(Object.values(MOVEMENT_REQUEST_COLUMNS));

export const mapMovementRequestLine = (row: ExportedRow) => {
  const column = MOVEMENT_REQUEST_COLUMNS;
  const text = (heading: string) => row[heading] ?? '';
  return {
    movement_request: text(column.movement_request),
    line_number: text(column.line_number),
    movement_request_type: text(column.movement_request_type),
    transaction_type: text(column.transaction_type),
    item: text(column.item),
    item_description: text(column.item_description),
    requested_quantity: num(row[column.requested_quantity]),
    delivered_quantity: num(row[column.delivered_quantity]),
    uom: text(column.uom),
    line_status: text(column.line_status),
    required_date: text(column.required_date),
    source_subinventory: text(column.source_subinventory),
    source_locator: text(column.source_locator),
    destination_subinventory: text(column.destination_subinventory),
    destination_locator: text(column.destination_locator),
    reason: text(column.reason),
    requester: text(column.requester),
    store_invoice: text(column.store_invoice),
    created_by: text(column.created_by),
    additional_columns: Object.fromEntries(
      Object.entries(row).filter(([heading]) => !KNOWN_MOVEMENT_REQUEST_COLUMNS.has(heading)),
    ),
  };
};

/** One pick of a movement request line: where the stock was actually taken from. */
export const movementRequestPickSchema = z.object({
  line_number: z.string().describe('Movement request line the pick belongs to'),
  pick_status: z.string().describe('Status of the pick (e.g., Confirmed)'),
  requested_quantity: z.number().describe('Quantity the pick was for'),
  picked_quantity: z.number().describe('Quantity actually picked'),
  source_subinventory: z.string().describe('Subinventory the stock was picked from'),
  source_locator: z.string().describe('Locator the stock was picked from'),
  uom: z.string().describe('Unit of measure column of the pick, as Fusion shows it'),
});

export const mapMovementRequestPick = (row: ExportedRow) => ({
  line_number: row['Movement Request Line'] ?? '',
  pick_status: row['Pick Status'] ?? '',
  requested_quantity: num(row['Requested Quantity']),
  picked_quantity: num(row['Picked Quantity']),
  source_subinventory: row['Source Subinventory'] ?? '',
  source_locator: row['Source Locator'] ?? '',
  uom: row['UOM Name'] ?? '',
});

/** A movement request's own page: its header and the order it was raised for. */
export const movementRequestSchema = z.object({
  movement_request: z.string().describe('Movement request number'),
  description: z.string().describe('Description of the request, often the customer or store it serves'),
  movement_request_type: z.string().describe('Requisition, Replenishment, Pick wave, Shop floor or Recall'),
  status: z.string().describe('Status of the request as a whole (e.g., Preapproved, Approved, Closed)'),
  customer_name: z.string().describe('Customer the order is for; empty when unset'),
  customer_number: z.string().describe('Customer account number; empty when unset'),
  customer_po: z.string().describe('Customer purchase order number; empty when unset'),
  tams_order: z.string().describe('TAMS order number the request came from; empty when unset'),
  order_date: z.string().describe('Date of the originating order, as Fusion displays dates; empty when unset'),
  details: z
    .record(z.string(), z.string())
    .describe(
      'Every field of the request page and its Additional Information, keyed by the label Fusion shows ' +
        '(original order code, delivery dates, store MAC ID and any others)',
    ),
  picks: z
    .array(movementRequestPickSchema)
    .describe(
      'Picks of every line of the request (View Picks). A line’s own source fields are often blank because ' +
        'Fusion chooses the source when picking; the pick shows where the stock was really taken from. Empty ' +
        'when no line has been picked',
    ),
});

export const mapMovementRequest = (details: Record<string, string>, picks: ExportedRow[]) => ({
  picks: picks.map(mapMovementRequestPick),
  movement_request: details['Movement Request'] ?? '',
  description: details.Description ?? '',
  movement_request_type: details['Movement Request Type'] ?? '',
  status: details.Status ?? '',
  customer_name: details['Customer Name'] ?? '',
  customer_number: details['Customer Number'] ?? '',
  customer_po: details['Customer PO#'] ?? '',
  tams_order: details['TAMS Order#'] ?? '',
  order_date: details['Order Date'] ?? '',
  details,
});

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

/** An amount as Fusion shows it, with grouping separators and possibly a currency; null when blank. */
const amount = (cell: string | undefined): number | null => {
  const digits = (cell ?? '').replace(/[^0-9.-]/g, '');
  if (digits === '') return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
};

export const purchaseOrderSchema = z.object({
  order: z.string().describe('Purchase order number'),
  supplier: z.string().describe('Supplier name'),
  supplier_site: z.string().describe('Supplier site'),
  status: z.string().describe('Order status (e.g., Open, Closed for Receiving, Closed)'),
  creation_date: z.string().describe('When the order was created, as Fusion displays dates'),
  document_style: z.string().describe('Document style of the order'),
  total: z.number().nullable().describe('Order total excluding tax, in the order currency; null when blank'),
  additional_columns: z
    .record(z.string(), z.string())
    .describe('Any further columns the user has added to the results table, keyed by column heading'),
});

const PURCHASE_ORDER_COLUMNS = {
  order: 'Order',
  supplier: 'Supplier',
  supplier_site: 'Supplier Site',
  status: 'Status',
  creation_date: 'Creation Date',
  document_style: 'Document Style',
  total: 'Total (Excluding Tax)',
} as const;

const KNOWN_PURCHASE_ORDER_COLUMNS = new Set<string>(Object.values(PURCHASE_ORDER_COLUMNS));

export const mapPurchaseOrder = (row: ExportedRow) => {
  const column = PURCHASE_ORDER_COLUMNS;
  return {
    order: row[column.order] ?? '',
    supplier: row[column.supplier] ?? '',
    supplier_site: row[column.supplier_site] ?? '',
    status: row[column.status] ?? '',
    creation_date: row[column.creation_date] ?? '',
    document_style: row[column.document_style] ?? '',
    total: amount(row[column.total]),
    additional_columns: Object.fromEntries(
      Object.entries(row).filter(([heading]) => !KNOWN_PURCHASE_ORDER_COLUMNS.has(heading)),
    ),
  };
};

export const purchaseOrderLineSchema = z.object({
  line: z.string().describe('Line number'),
  item: z.string().describe('Item number'),
  description: z.string().describe('Item description'),
  quantity: z.number().nullable().describe('Quantity ordered'),
  price: z.number().nullable().describe('Unit price'),
  total: z.number().nullable().describe('Line total'),
  status: z.string().describe('Line status (e.g., Open, Closed, Closed for Receiving)'),
  location: z.string().describe('Ship-to location'),
  requested_delivery_date: z.string().describe('Requested delivery date, as exported (YYYY-MM-DD)'),
  received_quantity: z.number().nullable().describe('Quantity received so far (received_qty); null when blank'),
  backordered_quantity: z.number().nullable().describe('Quantity on backorder (backordered_qty); null when blank'),
  damaged_quantity: z.number().nullable().describe('Quantity received damaged (damaged_qty); null when blank'),
  columns: z
    .record(z.string(), z.string())
    .describe(
      'Every non-empty column of the line as the order page exports it, keyed by heading — Expense Type/Product ' +
        'Line, posted_date, unit_cost, Core Price and any fields your organization added',
    ),
});

export const mapPurchaseOrderLine = (row: ExportedRow) => ({
  line: row.Line ?? '',
  item: row.Item ?? '',
  description: row.Description ?? '',
  quantity: amount(row.Quantity),
  price: amount(row.Price),
  total: amount(row.Total),
  status: row.Status ?? '',
  location: row.Location ?? '',
  requested_delivery_date: row['Requested Delivery Date'] ?? '',
  received_quantity: amount(row.received_qty),
  backordered_quantity: amount(row.backordered_qty),
  damaged_quantity: amount(row.damaged_qty),
  columns: Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '')),
});

export const purchaseOrderDetailsSchema = z.object({
  header: z
    .record(z.string(), z.string())
    .describe(
      'Every field of the order page and its Additional Information, keyed by the label Fusion shows (Integration ' +
        'Source, Fulfilment From, Correlation ID and so on)',
    ),
  lines: z.array(purchaseOrderLineSchema).describe('Every line of the order'),
});
