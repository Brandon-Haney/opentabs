import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { INVENTORY_TASKS, INVENTORY_WORK_AREA_SETTING_LABEL, inventoryWorkArea } from '../inventory.js';
import { renderedRowsWithDetails } from '../results.js';
import type { Criterion } from '../search-page.js';
import { createSearchScreen } from '../search-screen.js';
import {
  DEFAULT_LIMIT,
  type ExportedRow,
  limitSchema,
  mapMovementRequest,
  mapMovementRequestLine,
  movementRequestLineSchema,
  movementRequestSchema,
  offsetSchema,
  totalSchema,
} from './schemas.js';

const screen = createSearchScreen({
  workArea: inventoryWorkArea,
  workAreaSetting: INVENTORY_WORK_AREA_SETTING_LABEL,
  category: INVENTORY_TASKS,
  task: 'Manage Movement Requests',
  // The locators, reason and requester are columns the table hides by default.
  results: renderedRowsWithDetails(/:_ATp:[^:]+$/, {
    showAllColumns: true,
    sections: ['Additional Information'],
    lineCommand: 'View Picks',
  }),
});

/** Requests one call may open; each costs about three round trips, and three more per line. */
const MAX_DETAILED_REQUESTS = 25;

/** Option each movement request type is listed under on the page. */
const MOVEMENT_REQUEST_TYPES = {
  requisition: 'Requisition',
  replenishment: 'Replenishment',
  pick_wave: 'Pick wave',
  shop_floor: 'Shop floor',
  recall: 'Recall',
} as const;

/** Option each line status is listed under on the page. */
const LINE_STATUSES = {
  incomplete: 'Incomplete',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  closed: 'Closed',
  canceled: 'Canceled',
  preapproved: 'Preapproved',
  canceled_by_source: 'Canceled by source',
} as const;

export const searchMovementRequests = defineTool({
  name: 'search_movement_requests',
  displayName: 'Search Movement Requests',
  description:
    'Search movement request lines — the Manage Movement Requests page of Inventory Management. Movement ' +
    'requests move stock between subinventories and locators (e.g., picking to STAGING for an order) or issue ' +
    'it. Each line returns the item, requested and delivered quantities, line status, source and destination ' +
    'subinventory and locator, reason, requester and store/invoice reference. At least one of ' +
    'movement_request, created_by, movement_request_type, transaction_type, item or line_status is required. ' +
    'Fusion returns at most 500 lines per search and a broader one is refused, so add an item, ' +
    'subinventory or status to a broad search. Set include_details for the customer and order behind each ' +
    'request and the picks showing where stock was really taken from. Runs in a background session.',
  summary: 'Search movement request lines with source and destination locators',
  icon: 'arrow-right-left',
  group: 'Inventory',
  input: z.object({
    movement_request: z.string().optional().describe('Exact movement request number (e.g., "ATL001-100001")'),
    created_by: z
      .string()
      .optional()
      .describe('User or integration that created the request, exactly as Fusion shows it (e.g., "INTEGRATION.ERP")'),
    movement_request_type: z
      .enum(['requisition', 'replenishment', 'pick_wave', 'shop_floor', 'recall'])
      .optional()
      .describe('Restrict to one movement request type'),
    transaction_type: z
      .string()
      .optional()
      .describe(
        'Transaction type, exactly as the page lists it (e.g., "Movement Request Transfer", "Sales Order Pick")',
      ),
    item: z.string().optional().describe('Exact item number'),
    line_status: z
      .enum([
        'incomplete',
        'pending_approval',
        'approved',
        'rejected',
        'closed',
        'canceled',
        'preapproved',
        'canceled_by_source',
      ])
      .optional()
      .describe(
        'Restrict to one line status. Open and allocated lines, the ones holding on-hand stock, are ' +
          '"preapproved", not "approved"',
      ),
    source_subinventory: z.string().optional().describe('Subinventory the material moves from'),
    destination_subinventory: z.string().optional().describe('Subinventory the material moves to'),
    include_details: z
      .boolean()
      .optional()
      .describe(
        'Also open each movement request on the returned page and read its header and Additional Information ' +
          '(customer name and number, customer PO, TAMS order, order date) and the picks of every line (where ' +
          `the stock was really taken from). Default false; at most ` +
          `${MAX_DETAILED_REQUESTS} requests per call, so narrow the search or lower limit`,
      ),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    lines: z
      .array(movementRequestLineSchema)
      .describe('Matching movement request lines, in the order Fusion lists them'),
    total: totalSchema,
    requests: z
      .array(movementRequestSchema)
      .optional()
      .describe('Each movement request the returned lines belong to, once. Present only when include_details is true'),
  }),
  handle: async (params, context) => {
    if (
      !params.movement_request &&
      !params.created_by &&
      !params.movement_request_type &&
      !params.transaction_type &&
      !params.item &&
      !params.line_status
    ) {
      throw ToolError.validation(
        'Provide at least one of movement_request, created_by, movement_request_type, transaction_type, item or ' +
          'line_status.',
      );
    }

    const criteria: Criterion[] = [
      { label: 'From Movement Request', text: params.movement_request ?? '' },
      { label: 'To Movement Request', text: params.movement_request ?? '' },
      { label: 'Created By', text: params.created_by ?? '' },
      {
        label: 'Movement Request Type',
        option: params.movement_request_type ? MOVEMENT_REQUEST_TYPES[params.movement_request_type] : '',
      },
      { label: 'Transaction Type', option: params.transaction_type ?? '' },
      { label: 'Item', text: params.item ?? '' },
      { label: 'Line Status', option: params.line_status ? LINE_STATUSES[params.line_status] : '' },
      { label: 'Source Subinventory', text: params.source_subinventory ?? '' },
      { label: 'Destination Subinventory', text: params.destination_subinventory ?? '' },
    ];

    const offset = params.offset ?? 0;
    const requestedPage = (rows: ExportedRow[]) =>
      rows.slice(offset, offset + (params.limit ?? DEFAULT_LIMIT)).map(mapMovementRequestLine);
    const requestsOn = (rows: ExportedRow[]) => [...new Set(requestedPage(rows).map(line => line.movement_request))];

    const results = await screen.search(criteria, message => context?.reportProgress({ message }), {
      pickRows: params.include_details
        ? rows => {
            const requests = requestsOn(rows);
            if (requests.length > MAX_DETAILED_REQUESTS) {
              throw ToolError.validation(
                `The returned lines belong to ${requests.length} movement requests; include_details opens at most ` +
                  `${MAX_DETAILED_REQUESTS}. Narrow the search or lower limit.`,
              );
            }
            return requests;
          }
        : undefined,
    });

    const lines = requestedPage(results.rows);
    return {
      lines,
      total: results.rows.length,
      ...(params.include_details && {
        requests: requestsOn(results.rows).map(request =>
          mapMovementRequest(results.details.get(request) ?? {}, results.lineDialogs.get(request) ?? []),
        ),
      }),
    };
  },
});
