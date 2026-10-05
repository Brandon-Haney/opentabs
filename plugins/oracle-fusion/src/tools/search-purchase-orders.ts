import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { PURCHASE_ORDERS_WORK_AREA_SETTING_LABEL, purchaseOrdersWorkArea } from '../procurement.js';
import { exportedRowsWithDetails } from '../results.js';
import type { Criterion } from '../search-page.js';
import { createSearchScreen } from '../search-screen.js';
import {
  DEFAULT_LIMIT,
  type ExportedRow,
  limitSchema,
  mapPurchaseOrder,
  mapPurchaseOrderLine,
  offsetSchema,
  purchaseOrderDetailsSchema,
  purchaseOrderSchema,
  totalSchema,
} from './schemas.js';

const screen = createSearchScreen({
  workArea: purchaseOrdersWorkArea,
  workAreaSetting: PURCHASE_ORDERS_WORK_AREA_SETTING_LABEL,
  task: 'Manage Orders',
  results: exportedRowsWithDetails,
});

/** Orders one call may open; each costs a few round trips and an export. */
const MAX_DETAILED_ORDERS = 10;

/** Option each order status is listed under on the page. */
const ORDER_STATUSES = [
  'Canceled',
  'Closed',
  'Closed for Invoicing',
  'Closed for Receiving',
  'Finally Closed',
  'Incomplete',
  'On Hold',
  'Open',
  'Pending Approval',
  'Pending Change Approval',
  'Pending Funds Reservation',
  'Pending Supplier Acknowledgment',
  'Rejected',
  'Withdrawn',
] as const;

export const searchPurchaseOrders = defineTool({
  name: 'search_purchase_orders',
  displayName: 'Search Purchase Orders',
  description:
    'Search purchase orders — the Manage Orders page of the Purchase Orders work area. Returns each order’s ' +
    'supplier, site, status, creation date and total. Set include_lines to also open each returned order and ' +
    'read its full header and every line: item, quantity, price, total, line status, location and the received, ' +
    `backordered and damaged quantities. include_lines opens at most ${MAX_DETAILED_ORDERS} orders per call. ` +
    'Every buyer’s orders are searched, and closed orders are included unless include_closed is false. Runs in ' +
    'a background session.',
  summary: 'Search purchase orders and read their lines',
  icon: 'shopping-cart',
  group: 'Purchasing',
  input: z.object({
    order: z.string().optional().describe('Exact purchase order number (e.g., "ATL001-ZZZ09207")'),
    keywords: z.string().optional().describe('Words to search for across the order'),
    supplier: z.string().optional().describe('Supplier name, exactly as Fusion lists it (e.g., "ATL ATLANTA DC")'),
    requisition: z.string().optional().describe('Requisition number the order came from'),
    status: z.enum(ORDER_STATUSES).optional().describe('Restrict to one order status'),
    include_closed: z
      .boolean()
      .optional()
      .describe('Include closed orders (default true). The page itself leaves them out unless asked'),
    include_lines: z
      .boolean()
      .optional()
      .describe(
        `Open each returned order and read its header and every line (default false; at most ` +
          `${MAX_DETAILED_ORDERS} orders, so lower limit)`,
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    orders: z
      .array(purchaseOrderSchema.extend({ details: purchaseOrderDetailsSchema.optional() }))
      .describe(
        'Matching orders, in the order Fusion lists them. Each has details (header and lines) only when ' +
          'include_lines is true',
      ),
    total: totalSchema,
  }),
  handle: async (params, context) => {
    if (!params.order && !params.keywords && !params.supplier && !params.requisition && !params.status) {
      throw ToolError.validation('Provide at least one of order, keywords, supplier, requisition or status.');
    }

    const criteria: Criterion[] = [
      { label: 'Keywords', text: params.keywords ?? '' },
      { label: 'Supplier', text: params.supplier ?? '' },
      // The page fills Buyer with the signed-in user, which would hide every other buyer's orders.
      { label: 'Buyer', text: '' },
      { label: 'Order', text: params.order ?? '' },
      { label: 'Requisition', text: params.requisition ?? '' },
      { label: 'Status', option: params.status ?? '' },
      { label: 'Include Closed Documents', option: params.include_closed === false ? 'No' : 'Yes' },
    ];

    const offset = params.offset ?? 0;
    const requestedPage = (rows: ExportedRow[]) =>
      rows.slice(offset, offset + (params.limit ?? DEFAULT_LIMIT)).map(mapPurchaseOrder);

    const results = await screen.search(criteria, message => context?.reportProgress({ message }), {
      pickRows: params.include_lines
        ? rows => {
            const orders = requestedPage(rows).map(order => order.order);
            if (orders.length > MAX_DETAILED_ORDERS) {
              throw ToolError.validation(
                `${orders.length} orders are on the returned page; include_lines opens at most ` +
                  `${MAX_DETAILED_ORDERS}. Lower limit or narrow the search.`,
              );
            }
            return orders;
          }
        : undefined,
      exportDetailTable: params.include_lines === true,
    });

    return {
      orders: requestedPage(results.rows).map(order => ({
        ...order,
        ...(params.include_lines && {
          details: {
            header: results.details.get(order.order) ?? {},
            lines: (results.detailTables.get(order.order) ?? []).map(mapPurchaseOrderLine),
          },
        }),
      })),
      total: results.rows.length,
    };
  },
});
