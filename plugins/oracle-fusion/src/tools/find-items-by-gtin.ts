import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { normalizeGtin } from '../gtin.js';
import {
  gtinCriteria,
  type ItemRow,
  type ItemSearchResults,
  MASTER_ORGANIZATION,
  manageItemsScreen,
} from '../product-information.js';
import type { StatusReporter } from '../search-screen.js';
import { gtinSchema, itemAssignmentSchema, itemSchema, mapGtin, mapItem, mapItemAssignment } from './schemas.js';

/** Barcodes one call may look up; each is one search, plus an item page per match with include_details. */
const MAX_BARCODES = 25;

const itemKey = (row: ItemRow): string => (row.columns.Item ?? '').trim().toUpperCase();

/** The first row of each item, preferring the one in the given organization. */
const oneRowPerItem = (rows: ItemRow[], organization: string): ItemRow[] => {
  const chosen = new Map<string, ItemRow>();
  for (const row of rows) {
    const known = chosen.get(itemKey(row));
    if (!known || (known.columns.Organization !== organization && row.columns.Organization === organization)) {
      chosen.set(itemKey(row), row);
    }
  }
  return [...chosen.values()];
};

const matchedItemSchema = itemSchema.extend({
  organizations: z.array(itemAssignmentSchema).describe('Each organization the item is assigned to'),
  gtin_rows: z
    .array(gtinSchema)
    .optional()
    .describe(
      'The rows of the item’s GTIN table for this GTIN (unit of measure, party and so on), read from its item ' +
        'page. Present only when include_details is true.',
    ),
});

/** Groups the result rows of one GTIN by item, with what each item's page shows for that GTIN. */
const matchedItems = (found: ItemSearchResults, gtin: string, organization: string, withDetails: boolean) =>
  oneRowPerItem(found.rows, organization).map(first => {
    const rows = found.rows.filter(row => itemKey(row) === itemKey(first));
    const gtins = found.relationships.get(first.rowKey)?.gtins;
    return {
      ...mapItem(first.columns),
      organizations: rows.map(row => mapItemAssignment(row.columns)),
      ...(withDetails ? { gtin_rows: (gtins ?? []).map(mapGtin).filter(row => row.gtin === gtin) } : {}),
    };
  });

export const findItemsByGtin = defineTool({
  name: 'find_items_by_gtin',
  displayName: 'Find Items by GTIN',
  description:
    'Find every item that carries a barcode, through Manage Items in Product Information Management. Give each ' +
    'barcode as scanned: a 12-digit UPC-A, a 13-digit EAN or a 14-digit GTIN; it is padded to the GTIN-14 Fusion ' +
    'stores and its check digit is checked (a wrong check digit is reported, and the barcode is still searched). ' +
    'Every matching item is returned, not just the first: a GTIN on more than one item is a data error, as is a ' +
    'GTIN on the wrong item. With include_details, each matching item’s page is read for the GTIN’s unit of ' +
    'measure and party, one page per item. Runs in a background session, so the Fusion page on screen does ' +
    'not change. To list an item’s GTINs, use get_item_gtins.',
  summary: 'Find the items a barcode (GTIN, UPC or EAN) belongs to',
  icon: 'scan-barcode',
  group: 'Items',
  input: z.object({
    barcodes: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BARCODES)
      .describe(`Barcodes as scanned (e.g., "087295247914"), at most ${MAX_BARCODES}`),
    include_details: z
      .boolean()
      .optional()
      .describe('Also read the GTIN’s unit of measure, party and packed item from each matching item’s page'),
    organization: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Organization whose item page include_details reads (default ${MASTER_ORGANIZATION}, the item master, ` +
          'which holds the GTINs)',
      ),
  }),
  output: z.object({
    barcodes: z
      .array(
        z.object({
          barcode: z.string().describe('The barcode as given'),
          gtin: z
            .string()
            .nullable()
            .describe('The barcode as the GTIN-14 Fusion stores; null when it is not a barcode'),
          check_digit_valid: z
            .boolean()
            .nullable()
            .describe('Whether the last digit is the right GS1 check digit; null when it is not a barcode'),
          status: z
            .enum(['found', 'not_found', 'invalid'])
            .describe(
              'found: at least one item carries the GTIN. not_found: no item does. invalid: the barcode is not a ' +
                '12-, 13- or 14-digit number and was not searched',
            ),
          problem: z.string().nullable().describe('Why the barcode is invalid; null otherwise'),
          items: z.array(matchedItemSchema).describe('Every item that carries the GTIN'),
        }),
      )
      .describe('One entry per barcode given, in the order given'),
  }),
  handle: async (params, context) => {
    const report: StatusReporter = message => context?.reportProgress({ message });
    const organization = (params.organization ?? MASTER_ORGANIZATION).trim();
    const withDetails = params.include_details === true;

    const searched = new Map<string, ItemSearchResults>();
    const barcodes = [];
    for (const [index, barcode] of params.barcodes.entries()) {
      const normalized = normalizeGtin(barcode);
      if (!normalized.valid) {
        barcodes.push({
          barcode,
          gtin: null,
          check_digit_valid: null,
          status: 'invalid' as const,
          problem: normalized.problem,
          items: [],
        });
        continue;
      }

      const { gtin } = normalized;
      let found = searched.get(gtin);
      if (!found) {
        report(`Searching GTIN ${gtin} (${index + 1} of ${params.barcodes.length})`);
        found = await manageItemsScreen.search(gtinCriteria(gtin), report, {
          pick: rows => (withDetails ? oneRowPerItem(rows, organization) : []),
          relationships: ['gtins'],
        });
        searched.set(gtin, found);
      }
      const items = matchedItems(found, gtin, organization, withDetails);
      barcodes.push({
        barcode,
        gtin,
        check_digit_valid: normalized.checkDigitValid,
        status: items.length > 0 ? ('found' as const) : ('not_found' as const),
        problem: null,
        items,
      });
    }
    return { barcodes };
  },
});
