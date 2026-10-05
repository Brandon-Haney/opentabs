import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { INVENTORY_TASKS, INVENTORY_WORK_AREA_SETTING_LABEL, inventoryWorkArea } from '../inventory.js';
import { treeRows } from '../results.js';
import type { Criterion } from '../search-page.js';
import { createSearchScreen } from '../search-screen.js';
import { DESCRIPTION_OPERATORS, descriptionMatchSchema, itemQuantitySchema, mapItemQuantity } from './schemas.js';

/** Rows whose availability one call may read; each costs three round trips. */
const MAX_AVAILABILITY_ROWS = 40;

const screen = createSearchScreen({
  workArea: inventoryWorkArea,
  workAreaSetting: INVENTORY_WORK_AREA_SETTING_LABEL,
  category: INVENTORY_TASKS,
  task: 'View Item Quantities',
  results: treeRows,
});

export const getItemQuantities = defineTool({
  name: 'get_item_quantities',
  displayName: 'Get Item Quantities',
  description:
    'Get current on-hand, receiving and inbound quantities for items in an inventory organization — the View ' +
    'Item Quantities page of Inventory Management. Each item is broken down by organization, subinventory and ' +
    'locator, returned as one row per level so totals and bin-level quantities can both be read: filter rows by ' +
    'level to pick the granularity. Search by exact item number, or by item description to cover several items ' +
    'at once; a description search returns on-hand quantities only, because Fusion reports receiving and ' +
    'inbound only for a named item. Quantities are live and can be negative. The search runs in a background ' +
    'session, so the Fusion page on screen does not change. Fusion refuses searches that match too many items; ' +
    'narrow the description if that happens.',
  summary: 'Get on-hand, receiving and inbound quantities by subinventory and locator',
  icon: 'boxes',
  group: 'Inventory',
  input: z.object({
    organization: z.string().min(1).describe('Inventory organization code, as shown in the Organization field'),
    item: z.string().optional().describe('Exact item number. Required unless item_description is given.'),
    item_description: z
      .string()
      .optional()
      .describe('Text to match against the item description, compared as set by item_description_match'),
    item_description_match: descriptionMatchSchema,
    subinventory: z.string().optional().describe('Subinventory code, to return quantities in that subinventory only'),
    include_availability: z
      .boolean()
      .optional()
      .describe(
        'Also read available-to-transact and available-to-reserve for every row (default false). Shows stock that ' +
          'is on hand but not sellable, such as reserved, picked or staged quantities. Costs three round trips per ' +
          `row, so it is refused for results of more than ${MAX_AVAILABILITY_ROWS} rows; name an item or a ` +
          'subinventory. When on hand exceeds available, search_movement_requests with the item and line_status ' +
          '"preapproved" finds the open request holding the stock',
      ),
  }),
  output: z.object({
    quantities: z
      .array(itemQuantitySchema)
      .describe(
        'One row per level of each item: the item total, then each organization, subinventory and locator ' +
          'beneath it, in that order. Empty when no item matches or the item has no quantity',
      ),
  }),
  handle: async (params, context) => {
    if (!params.item && !params.item_description) {
      throw ToolError.validation('Provide item or item_description — Fusion refuses a search across every item.');
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
      { label: 'Subinventory', text: params.subinventory ?? '' },
      { label: 'On Hand', checked: true },
      // Fusion accepts more than one kind of quantity only when the search names an item.
      { label: 'Receiving', checked: Boolean(params.item) },
      { label: 'Inbound', checked: Boolean(params.item) },
    ];

    const tree = await screen.search(criteria, message => context?.reportProgress({ message }), {
      pickAvailabilityRows: rows => {
        if (!params.include_availability) return [];
        if (rows.length > MAX_AVAILABILITY_ROWS) {
          throw ToolError.validation(
            `The search returned ${rows.length} rows; include_availability reads at most ` +
              `${MAX_AVAILABILITY_ROWS}. Name an item or a subinventory to narrow it.`,
          );
        }
        return rows.map(row => row.key);
      },
    });

    const labels = new Map(tree.rows.map(row => [row.key, row.label]));
    const valuesOf = (cells: string[]) =>
      Object.fromEntries(tree.columns.map((column, index) => [column, cells[index] ?? '']));
    const descriptions = new Map(
      tree.rows
        .filter(row => row.ancestors.length === 0)
        .map(row => [row.key, valuesOf(row.cells)['Item Description'] ?? '']),
    );

    return {
      quantities: tree.rows.map(row =>
        mapItemQuantity({
          label: row.label,
          ancestorLabels: row.ancestors.map(key => labels.get(key) ?? ''),
          values: valuesOf(row.cells),
          itemDescription: descriptions.get(row.ancestors[0] ?? row.key) ?? '',
          availability: tree.availability.get(row.key),
        }),
      ),
    };
  },
});
