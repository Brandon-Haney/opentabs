import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import type { RelationshipKind } from '../item-page.js';
import { type ItemRow, itemCriteria, MASTER_ORGANIZATION, manageItemsScreen } from '../product-information.js';
import type { StatusReporter } from '../search-screen.js';
import {
  crossReferenceSchema,
  gtinSchema,
  itemAssignmentSchema,
  itemSchema,
  mapCrossReference,
  mapGtin,
  mapItem,
  mapItemAssignment,
  mapTradingPartnerItem,
  tradingPartnerItemSchema,
} from './schemas.js';

const ONLY_WITH_OTHER_RELATIONSHIPS = 'Present only when include_other_relationships is true.';

const sameItem = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

export const getItemGtins = defineTool({
  name: 'get_item_gtins',
  displayName: 'Get Item GTINs',
  description:
    'List the GTINs (barcodes) of one item, as the item page in Product Information Management shows them under ' +
    'Relationships → GTIN: one row per GTIN with its unit of measure (EACH, EACH10, BOX20…), party and packed ' +
    'item. GTINs live on the item in the item master, organization 100000, which is the default. Optionally also ' +
    'reads the Cross-References and Trading Partner Items of the same Relationships tab. The item page opens in ' +
    'edit mode; the tool only reads it and closes it with Cancel, so nothing is saved. Runs in a background ' +
    'session, so the Fusion page on screen does not change. To go from a barcode to its items, use ' +
    'find_items_by_gtin.',
  summary: 'List the GTINs (barcodes) of an item',
  icon: 'barcode',
  group: 'Items',
  input: z.object({
    item: z.string().min(1).describe('Exact item number (e.g., "4115-NGK")'),
    organization: z
      .string()
      .min(1)
      .optional()
      .describe(`Organization whose item page is read (default ${MASTER_ORGANIZATION}, the item master)`),
    include_other_relationships: z
      .boolean()
      .optional()
      .describe('Also read the Cross-References and Trading Partner Items tabs (default false)'),
  }),
  output: itemSchema.extend({
    organization: itemAssignmentSchema.shape.organization,
    approval_status: itemAssignmentSchema.shape.approval_status,
    item_status: itemAssignmentSchema.shape.item_status,
    gtins: z.array(gtinSchema).describe('Every GTIN of the item; empty when it has none'),
    cross_references: z
      .array(crossReferenceSchema)
      .optional()
      .describe(`Every cross-reference of the item. ${ONLY_WITH_OTHER_RELATIONSHIPS}`),
    trading_partner_items: z
      .array(tradingPartnerItemSchema)
      .optional()
      .describe(`Every trading partner item of the item. ${ONLY_WITH_OTHER_RELATIONSHIPS}`),
  }),
  handle: async (params, context) => {
    const report: StatusReporter = message => context?.reportProgress({ message });
    const item = params.item.trim();
    const organization = (params.organization ?? MASTER_ORGANIZATION).trim();
    const kinds: RelationshipKind[] = params.include_other_relationships
      ? ['gtins', 'crossReferences', 'tradingPartnerItems']
      : ['gtins'];

    const isWanted = (row: ItemRow) =>
      sameItem(row.columns.Item ?? '', item) && (row.columns.Organization ?? '') === organization;
    const found = await manageItemsScreen.search(itemCriteria(item), report, {
      pick: rows => rows.filter(isWanted).slice(0, 1),
      relationships: kinds,
    });

    const row = found.rows.find(isWanted);
    const read = row ? found.relationships.get(row.rowKey) : undefined;
    if (!(row && read)) {
      const organizations = found.rows.filter(candidate => sameItem(candidate.columns.Item ?? '', item));
      throw ToolError.validation(
        organizations.length === 0
          ? `Oracle Fusion has no item ${item}.`
          : `Item ${item} is not assigned to organization ${organization}; it is in ` +
              `${organizations.map(candidate => candidate.columns.Organization).join(', ')}.`,
      );
    }

    return {
      ...mapItem(row.columns),
      ...mapItemAssignment(row.columns),
      gtins: (read.gtins ?? []).map(mapGtin),
      ...(params.include_other_relationships
        ? {
            cross_references: (read.crossReferences ?? []).map(mapCrossReference),
            trading_partner_items: (read.tradingPartnerItems ?? []).map(mapTradingPartnerItem),
          }
        : {}),
    };
  },
});
