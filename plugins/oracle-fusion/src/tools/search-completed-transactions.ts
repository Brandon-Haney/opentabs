import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { INVENTORY_TASKS, INVENTORY_WORK_AREA_SETTING_LABEL, inventoryWorkArea } from '../inventory.js';
import { exportedRowsWithDetails } from '../results.js';
import type { Criterion } from '../search-page.js';
import { createSearchScreen } from '../search-screen.js';
import {
  completedTransactionDetailsSchema,
  completedTransactionSchema,
  DEFAULT_LIMIT,
  DESCRIPTION_OPERATORS,
  descriptionMatchSchema,
  type ExportedRow,
  isoDateSchema,
  limitSchema,
  mapCompletedTransaction,
  mapCompletedTransactionDetails,
  offsetSchema,
  totalSchema,
} from './schemas.js';

const screen = createSearchScreen({
  workArea: inventoryWorkArea,
  workAreaSetting: INVENTORY_WORK_AREA_SETTING_LABEL,
  category: INVENTORY_TASKS,
  task: 'Review Completed Transactions',
  results: exportedRowsWithDetails,
});

/** Rows one call may read in full; each costs five round trips. */
const MAX_DETAILED_ROWS = 100;
const DEFAULT_DETAILED_ROWS = 25;

export const searchCompletedTransactions = defineTool({
  name: 'search_completed_transactions',
  displayName: 'Search Completed Transactions',
  description:
    'Search completed inventory transactions for an inventory organization — the Review Completed ' +
    'Transactions page of Inventory Management. Returns every receipt, issue, transfer and adjustment ' +
    'matching the criteria with subinventory, locator, quantity, source document and timestamps, oldest ' +
    'first. Either item or a transaction date range is required. Filter values must match the names Fusion ' +
    'shows (a subinventory code, a source type such as "Sales Order"). Runs in a background session. One day ' +
    'of a whole organization is around a thousand rows and ten seconds. The table has no transaction type, ' +
    'reason or user: set include_details to also read each returned transaction’s detail page and About This ' +
    'Record (type, action, reason, transfer side, created and last updated by). That costs several round ' +
    'trips per transaction, so the default page becomes 25 and the maximum 100.',
  summary: 'Search completed inventory transactions by item, date and source',
  icon: 'package-search',
  group: 'Inventory',
  input: z.object({
    organization: z.string().min(1).describe('Inventory organization code, as shown in the Organization field'),
    item: z.string().optional().describe('Exact item number. Required unless both date_from and date_to are given.'),
    item_description: z
      .string()
      .optional()
      .describe('Text to match against the item description, compared as set by item_description_match'),
    item_description_match: descriptionMatchSchema,
    date_from: isoDateSchema
      .optional()
      .describe('First transaction date to include, YYYY-MM-DD. Must be given together with date_to.'),
    date_to: isoDateSchema
      .optional()
      .describe('Last transaction date to include (inclusive), YYYY-MM-DD. Must be given together with date_from.'),
    subinventory: z.string().optional().describe('Subinventory code to restrict the search to'),
    source_type: z
      .string()
      .optional()
      .describe('Transaction source type name, exactly as Fusion lists it (e.g., "Purchase Order", "Sales Order")'),
    transaction_type: z.string().optional().describe('Transaction type name, exactly as Fusion lists it'),
    transaction_action: z.string().optional().describe('Transaction action name, exactly as Fusion lists it'),
    include_details: z
      .boolean()
      .optional()
      .describe(
        'Read each returned transaction’s detail page and About This Record (default false): transaction type, ' +
          'action, reason, transfer side, who created and last updated it, and every other detail field',
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    transactions: z
      .array(completedTransactionSchema.merge(completedTransactionDetailsSchema.partial()))
      .describe('Matching transactions, ordered by transaction date then transaction number'),
    total: totalSchema,
  }),
  handle: async (params, context) => {
    if ((params.date_from === undefined) !== (params.date_to === undefined)) {
      throw ToolError.validation('date_from and date_to must be given together.');
    }
    if (!params.item && params.date_from === undefined) {
      throw ToolError.validation('Provide item, or both date_from and date_to — Fusion requires at least one.');
    }

    const criteria: Criterion[] = [
      { label: 'Organization', text: params.organization, leading: true },
      { label: 'Item', text: params.item ?? '' },
      {
        label: 'Item Description Operator',
        text: DESCRIPTION_OPERATORS[params.item_description_match ?? 'starts_with'],
        leading: true,
      },
      { label: 'Item Description', text: params.item_description ?? '' },
      { label: 'From Transaction Date', date: params.date_from ?? null },
      { label: 'To Transaction Date', date: params.date_to ?? null },
      { label: 'Subinventory', text: params.subinventory ?? '' },
      { label: 'Source Type', text: params.source_type ?? '' },
      { label: 'Transaction Type', text: params.transaction_type ?? '' },
      { label: 'Transaction Action', text: params.transaction_action ?? '' },
    ];

    const withDetails = params.include_details === true;
    if (withDetails && (params.limit ?? 0) > MAX_DETAILED_ROWS) {
      throw ToolError.validation(`With include_details, limit can be at most ${MAX_DETAILED_ROWS}.`);
    }
    const offset = params.offset ?? 0;
    const limit = params.limit ?? (withDetails ? DEFAULT_DETAILED_ROWS : DEFAULT_LIMIT);

    /** Every matching transaction, oldest first. */
    const ordered = (rows: ExportedRow[]) =>
      rows
        .map(mapCompletedTransaction)
        .sort(
          (a, b) =>
            a.transaction_date.localeCompare(b.transaction_date) ||
            a.transaction_id.localeCompare(b.transaction_id, undefined, { numeric: true }),
        );
    const requestedPage = (rows: ExportedRow[]) => ordered(rows).slice(offset, offset + limit);

    const results = await screen.search(criteria, message => context?.reportProgress({ message }), {
      pickRows: withDetails ? rows => requestedPage(rows).map(transaction => transaction.transaction_id) : undefined,
      readAudit: withDetails,
    });

    return {
      transactions: requestedPage(results.rows).map(transaction =>
        withDetails
          ? {
              ...transaction,
              ...mapCompletedTransactionDetails(
                results.details.get(transaction.transaction_id) ?? {},
                results.audits.get(transaction.transaction_id) ?? {},
              ),
            }
          : transaction,
      ),
      total: results.rows.length,
    };
  },
});
