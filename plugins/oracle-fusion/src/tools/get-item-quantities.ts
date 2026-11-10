import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { INVENTORY_TASKS, INVENTORY_WORK_AREA_SETTING_LABEL, inventoryWorkArea } from '../inventory.js';
import { treeRows } from '../results.js';
import type { Criterion } from '../search-page.js';
import { createSearchScreen, isUnknownValue, SearchRejectedError } from '../search-screen.js';
import { DESCRIPTION_OPERATORS, descriptionMatchSchema, itemQuantitySchema, mapItemQuantity } from './schemas.js';

/** Rows whose availability one call may read; each costs three round trips. */
const MAX_AVAILABILITY_ROWS = 40;

/** What a search that found nothing looked for, and what to check, in a sentence or two. */
export const nothingFoundMessage = (search: {
  organization: string;
  item?: string;
  item_description?: string;
  item_description_match?: keyof typeof DESCRIPTION_OPERATORS;
  subinventory?: string;
  locator?: string;
}): string => {
  const match = (search.item_description_match ?? 'starts_with').replace('_', ' ');
  const what = search.item
    ? `item ${search.item}`
    : search.item_description
      ? `items whose description ${match} "${search.item_description}"`
      : 'any item';
  const where = [
    search.organization,
    ...(search.subinventory ? [`subinventory ${search.subinventory}`] : []),
    ...(search.locator ? [`locator ${search.locator}`] : []),
  ].join(', ');
  const check = search.item
    ? 'The item may have nothing on hand, receiving or inbound there; check that the item number is entered correctly.'
    : 'Nothing may be stored there; check that the search values are entered correctly.';
  return `Oracle Fusion shows no quantities for ${what} in ${where}. ${check}`;
};

/** Search fields whose lookup refuses a value it does not know, with the search value each holds. */
const LOOKUP_FIELDS = {
  Organization: 'organization',
  Item: 'item',
  Subinventory: 'subinventory',
  Locator: 'locator',
} as const;

/**
 * The message for a search Fusion refused because a field does not know the value entered in
 * it, such as a mistyped item number; null for any other refusal, which stays an error as it is.
 */
export const unknownValueMessage = (
  error: SearchRejectedError,
  search: { organization: string; item?: string; subinventory?: string; locator?: string },
): string | null => {
  const fields = error.messages.map(message =>
    isUnknownValue(message) && message.field in LOOKUP_FIELDS
      ? LOOKUP_FIELDS[message.field as keyof typeof LOOKUP_FIELDS]
      : null,
  );
  if (fields.length === 0 || fields.some(field => field === null)) return null;
  const sentences = [...new Set(fields)].map(field =>
    field === 'organization'
      ? `Oracle Fusion has no organization ${search.organization}.`
      : `Oracle Fusion has no ${field} ${search[field as 'item' | 'subinventory' | 'locator'] ?? ''} in ${search.organization}.`,
  );
  return `${sentences.join(' ')} Check that it is entered correctly.`;
};

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
    'level to pick the granularity. Search by exact item number, by item description to cover several items ' +
    'at once, or by locator to list everything stored in one bin; a search without an item number returns ' +
    'on-hand quantities only, because Fusion reports receiving and inbound only for a named item. Quantities ' +
    'are live and can be negative. The search runs in a background session, so the Fusion page on screen does ' +
    'not change. Fusion refuses searches that match too many items; narrow the description if that happens.',
  summary: 'Get on-hand, receiving and inbound quantities by subinventory and locator',
  icon: 'boxes',
  group: 'Inventory',
  input: z.object({
    organization: z.string().min(1).describe('Inventory organization code, as shown in the Organization field'),
    item: z.string().optional().describe('Exact item number. Required unless item_description or locator is given.'),
    item_description: z
      .string()
      .optional()
      .describe('Text to match against the item description, compared as set by item_description_match'),
    item_description_match: descriptionMatchSchema,
    subinventory: z.string().optional().describe('Subinventory code, to return quantities in that subinventory only'),
    locator: z
      .string()
      .optional()
      .describe('Exact locator (e.g., "TOT.01.01"), to return quantities in that locator only'),
    include_availability: z
      .boolean()
      .optional()
      .describe(
        'Also read available-to-transact and available-to-reserve for every row (default false). Shows stock that ' +
          'is on hand but not sellable, such as reserved, picked or staged quantities. Costs three round trips per ' +
          `row, so it is refused for results of more than ${MAX_AVAILABILITY_ROWS} rows; name an item, a ` +
          'subinventory or a locator. When on hand exceeds available, search_movement_requests with the item and ' +
          'line_status "preapproved" finds the open request holding the stock',
      ),
  }),
  output: z.object({
    quantities: z
      .array(itemQuantitySchema)
      .describe(
        'One row per level of each item: the item total, then each organization, subinventory and locator ' +
          'beneath it, in that order. Empty when the search found nothing; message then says so',
      ),
    message: z
      .string()
      .optional()
      .describe(
        'Present only when the search found nothing: what was searched for, that the item may have no ' +
          'quantity there, and to check the values were entered correctly',
      ),
  }),
  handle: async (params, context) => {
    if (!params.item && !params.item_description && !params.locator) {
      throw ToolError.validation(
        'Provide item, item_description or locator — Fusion refuses a search across every item.',
      );
    }

    const criteria: Criterion[] = [
      { label: 'Organization', text: params.organization, leading: true },
      { label: 'Item', text: params.item ?? '' },
      {
        label: 'Item Description Operator',
        text: DESCRIPTION_OPERATORS[params.item_description_match ?? 'starts_with'],
        leading: true,
      },
      // The page replaces the description with the item's own when an item is named.
      { label: 'Item Description', text: params.item_description ?? '', filledByPage: Boolean(params.item) },
      { label: 'Subinventory', text: params.subinventory ?? '' },
      // Locator is not on the panel until it is added from Add Fields; the screen adds it.
      { label: 'Locator', text: params.locator ?? '' },
      { label: 'On Hand', checked: true },
      // Fusion accepts more than one kind of quantity only when the search names an item.
      { label: 'Receiving', checked: Boolean(params.item) },
      { label: 'Inbound', checked: Boolean(params.item) },
    ];

    const tree = await screen
      .search(criteria, message => context?.reportProgress({ message }), {
        pickAvailabilityRows: rows => {
          if (!params.include_availability) return [];
          if (rows.length > MAX_AVAILABILITY_ROWS) {
            throw ToolError.validation(
              `The search returned ${rows.length} rows; include_availability reads at most ` +
                `${MAX_AVAILABILITY_ROWS}. Name an item, a subinventory or a locator to narrow it.`,
            );
          }
          return rows.map(row => row.key);
        },
      })
      .catch((error: unknown) => {
        const unknown = error instanceof SearchRejectedError ? unknownValueMessage(error, params) : null;
        throw unknown ? ToolError.validation(unknown) : error;
      });
    if (tree.rows.length === 0) return { quantities: [], message: nothingFoundMessage(params) };

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
