import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { INVENTORY_TASKS, INVENTORY_WORK_AREA_SETTING_LABEL, inventoryWorkArea } from '../inventory.js';
import { exportedRowsWithDetails } from '../results.js';
import type { Criterion } from '../search-page.js';
import { createSearchScreen } from '../search-screen.js';
import {
  type ExportedRow,
  isoDateSchema,
  mapPendingTransaction,
  mapPendingTransactionDetails,
  offsetSchema,
  pendingTransactionDetailsSchema,
  pendingTransactionSchema,
  shiftIsoDate,
  totalSchema,
} from './schemas.js';

const screen = createSearchScreen({
  workArea: inventoryWorkArea,
  workAreaSetting: INVENTORY_WORK_AREA_SETTING_LABEL,
  category: INVENTORY_TASKS,
  task: 'Manage Pending Transactions',
  entryButton: 'View Pending Transactions',
  results: exportedRowsWithDetails,
});

/** Option each processing status is listed under on the page. */
const PROCESSING_STATUSES = {
  awaiting_approval: 'Awaiting approval',
  error: 'Error during processing',
  not_ready: 'Not ready to be processed',
  ready: 'Ready to be processed',
} as const;

/** Option each transaction status is listed under on the page. */
const TRANSACTION_STATUSES = { confirmed: 'Confirmed', unconfirmed: 'Unconfirmed' } as const;

const DEFAULT_LIMIT = 25;

export const searchPendingTransactions = defineTool({
  name: 'search_pending_transactions',
  displayName: 'Search Pending Transactions',
  description:
    'Search inventory transactions that have not posted to on-hand — the Manage Pending Transactions page of ' +
    'Inventory Management. These include transactions that failed, with Fusion’s error code and explanation, ' +
    'and ones waiting for approval or processing. A pending transaction has not changed on-hand, so it explains ' +
    'balances that disagree with what physically moved. Each result includes the full detail page (locator, ' +
    'destination subinventory and locator, source document, reason and any organization-specific fields). ' +
    'Details cost one round trip per transaction, so the default page is 25; set include_details to false for ' +
    'a fast count. Results are ordered oldest first. The search runs in a background session.',
  summary: 'Search pending and failed inventory transactions with their errors',
  icon: 'circle-alert',
  group: 'Inventory',
  input: z.object({
    organization: z.string().min(1).describe('Inventory organization code, as shown in the Organization field'),
    processing_status: z
      .enum(['awaiting_approval', 'error', 'not_ready', 'ready'])
      .optional()
      .describe('Restrict to one processing status; "error" returns transactions that failed. Omit for all'),
    transaction_status: z
      .enum(['confirmed', 'unconfirmed'])
      .optional()
      .describe('Restrict to confirmed or unconfirmed transactions. Omit for both'),
    item: z.string().optional().describe('Exact item number'),
    subinventory: z.string().optional().describe('Subinventory code'),
    source_type: z
      .string()
      .optional()
      .describe('Transaction source type name, exactly as Fusion lists it (e.g., "Sales Order", "Inventory")'),
    transaction_type: z
      .string()
      .optional()
      .describe('Transaction type name, exactly as Fusion lists it (e.g., "Subinventory Transfer")'),
    date_from: isoDateSchema
      .optional()
      .describe('First transaction date to include, YYYY-MM-DD. Must be given together with date_to.'),
    date_to: isoDateSchema
      .optional()
      .describe('Last transaction date to include (inclusive), YYYY-MM-DD. Must be given together with date_from.'),
    include_details: z
      .boolean()
      .optional()
      .describe('Read each returned transaction’s detail page (default true). False returns the table columns only'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum transactions to return (default 25, max 100). Page with offset rather than raising it.'),
    offset: offsetSchema,
  }),
  output: z.object({
    transactions: z
      .array(pendingTransactionSchema.merge(pendingTransactionDetailsSchema.partial()))
      .describe('Matching transactions, ordered by transaction date then transaction ID'),
    total: totalSchema,
  }),
  handle: async (params, context) => {
    if ((params.date_from === undefined) !== (params.date_to === undefined)) {
      throw ToolError.validation('date_from and date_to must be given together.');
    }

    // This page filters on transaction dates in a different time zone from the one it shows
    // them in, so a day searched as entered misses its evening and picks up the evening
    // before. The search asks for a day more on each side, and the rows are then kept by the
    // date they show, which is the date the caller means.
    const criteria: Criterion[] = [
      { label: 'Organization', text: params.organization, leading: true },
      { label: 'From Transaction Date', date: params.date_from ? shiftIsoDate(params.date_from, -1) : null },
      { label: 'To Transaction Date', date: params.date_to ? shiftIsoDate(params.date_to, 1) : null, timeOfDay: 'end' },
      { label: 'Subinventory', text: params.subinventory ?? '' },
      { label: 'Source Type', text: params.source_type ?? '' },
      { label: 'Transaction Type', text: params.transaction_type ?? '' },
      { label: 'Item', text: params.item ?? '' },
      {
        label: 'Processing Status',
        option: params.processing_status ? PROCESSING_STATUSES[params.processing_status] : '',
      },
      {
        label: 'Transaction Status',
        option: params.transaction_status ? TRANSACTION_STATUSES[params.transaction_status] : '',
      },
    ];

    const offset = params.offset ?? 0;
    const limit = params.limit ?? DEFAULT_LIMIT;
    const inDateRange = (transaction: { transaction_date: string }): boolean => {
      const day = transaction.transaction_date.slice(0, 10);
      return (!params.date_from || day >= params.date_from) && (!params.date_to || day <= params.date_to);
    };
    const matching = (rows: ExportedRow[]) => rows.map(row => mapPendingTransaction(row)).filter(inDateRange);

    /** The requested page of transactions, oldest first, before their details are read. */
    const requestedPage = (rows: ExportedRow[]) =>
      matching(rows)
        .sort(
          (a, b) =>
            a.transaction_date.localeCompare(b.transaction_date) ||
            a.transaction_id.localeCompare(b.transaction_id, undefined, { numeric: true }),
        )
        .slice(offset, offset + limit);

    const results = await screen.search(criteria, message => context?.reportProgress({ message }), {
      pickRows:
        params.include_details === false
          ? undefined
          : rows => requestedPage(rows).map(transaction => transaction.transaction_id),
    });

    return {
      transactions: requestedPage(results.rows).map(transaction =>
        params.include_details === false
          ? transaction
          : { ...transaction, ...mapPendingTransactionDetails(results.details.get(transaction.transaction_id) ?? {}) },
      ),
      total: matching(results.rows).length,
    };
  },
});
