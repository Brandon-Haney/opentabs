import { getConfig, ToolError } from '@opentabs-dev/plugin-sdk';
import { type RichResponse, viewportDeltas } from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';
import { parseFlatTable, parseRowKeys, recordsOf, rendersEveryRow } from './flat-table.js';
import {
  cancelItemEvent,
  findItemLink,
  findRelationshipLink,
  findRelationshipTable,
  findShownPopup,
  type ItemPage,
  openItemEvent,
  RELATIONSHIP_TABS,
  type RelationshipKind,
  readItemPage,
  relationshipRecords,
  showRelationshipEvent,
  showRelationshipsEvent,
  showsItemPage,
  withControlsOf,
} from './item-page.js';
import { type Criterion, findResultsTable } from './search-page.js';
import { createSearchScreen, type ResultsReader, refusedBy } from './search-screen.js';

/** Plugin setting that names the home page tile of the Product Information Management work area. */
export const PRODUCT_WORK_AREA_SETTING = 'productWorkArea';
export const PRODUCT_WORK_AREA_SETTING_LABEL = 'Product work area';

const DEFAULT_PRODUCT_WORK_AREA = 'Product Information Management';

/**
 * Label of the home page tile that opens the Product Information Management work area.
 * Organizations rename home page tiles, so the label is a setting with Oracle's name as the
 * default.
 */
export const productWorkArea = (): string => {
  const configured = getConfig(PRODUCT_WORK_AREA_SETTING);
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : DEFAULT_PRODUCT_WORK_AREA;
};

/** Organization whose item pages hold the items' GTINs: the item master. */
export const MASTER_ORGANIZATION = '100000';

/** Value an operator of the Manage Items panel submits to match a whole value. */
const EQUALS = '=';

/**
 * Criteria of a search for one item number. Every criterion is sent, so a value left over
 * from an earlier search in the same window is cleared.
 */
export const itemCriteria = (item: string): Criterion[] => [
  { label: 'Item Operator', text: EQUALS, leading: true },
  { label: 'Item', text: item },
  { label: 'Description', text: '' },
  { label: 'Keyword', text: '' },
  { label: 'GTIN', text: '' },
];

/**
 * Criteria of a search for the items that carry one GTIN. The page asks for an Item,
 * Description or Keyword before it searches, but that check runs in the browser only: the
 * server runs a search by GTIN alone.
 */
export const gtinCriteria = (gtin: string): Criterion[] => [
  { label: 'Item', text: '' },
  { label: 'Description', text: '' },
  { label: 'Keyword', text: '' },
  { label: 'GTIN Operator', text: EQUALS, leading: true },
  { label: 'GTIN', text: gtin },
];

/** One row of the Manage Items results: an item in one of the organizations it is assigned to. */
export interface ItemRow {
  rowKey: string;
  /** The row's values keyed by column heading (Item, Description, Organization, …). */
  columns: Record<string, string>;
}

/** What an item page's Relationships tab shows, one table of records per sub-tab read. */
export type ItemRelationships = Partial<Record<RelationshipKind, Record<string, string>[]>>;

/** What a search reads besides its result rows. */
export interface ItemSearchOptions {
  /** Picks the rows whose item page is opened. */
  pick?: (rows: ItemRow[]) => ItemRow[];
  /** Sub-tabs of the Relationships tab read on each item page opened. */
  relationships?: RelationshipKind[];
}

export interface ItemSearchResults {
  rows: ItemRow[];
  /** What each opened item page shows, keyed by the row key of the row it was opened from. */
  relationships: Map<string, ItemRelationships>;
}

/** Submits one step on an item page, failing on any error or warning Fusion answers it with. */
const step = async (adfWindow: AdfWindow, event: RichEvent, what: string): Promise<RichResponse> => {
  const response = await adfWindow.submit(event);
  const refused = refusedBy(response);
  if (refused.length > 0) {
    throw ToolError.internal(`Oracle Fusion answered ${what} with: ${refused.map(message => message.text).join(' ')}`);
  }
  return response;
};

/** Reads the chosen sub-tabs of an open item page's Relationships tab. */
const readRelationships = async (
  adfWindow: AdfWindow,
  opened: ItemPage,
  kinds: RelationshipKind[],
): Promise<{ page: ItemPage; relationships: ItemRelationships }> => {
  const relationships: ItemRelationships = {};
  if (kinds.length === 0) return { page: opened, relationships };
  let page = opened;
  let shown = await step(adfWindow, showRelationshipsEvent(page), `the Relationships tab of ${page.item}`);
  for (const kind of kinds) {
    page = withControlsOf(page, shown);
    const link = findRelationshipLink(shown, page, kind);
    if (!link) {
      throw ToolError.internal(
        `The Oracle Fusion item page of ${page.item} has no ${RELATIONSHIP_TABS[kind].label} sub-tab.`,
      );
    }
    shown = await step(adfWindow, showRelationshipEvent(page, link), `a Relationships sub-tab of ${page.item}`);
    let table = findRelationshipTable(shown, page, kind);
    if (!rendersEveryRow(table.table)) {
      // The sub-tab rendered only the table's first rows; shown again, it renders them all.
      shown = await step(
        adfWindow,
        showRelationshipEvent(page, link, table.id),
        `every row of a Relationships sub-tab of ${page.item}`,
      );
      table = findRelationshipTable(shown, page, kind);
    }
    relationships[kind] = relationshipRecords(table, page, kind);
  }
  return { page: withControlsOf(page, shown), relationships };
};

/**
 * Closes an item page with Cancel. An answer that still shows the page, or shows a dialog
 * such as a question about unsaved changes, is an error: nothing was changed, so Fusion has
 * nothing to ask.
 */
const cancelItemPage = async (adfWindow: AdfWindow, page: ItemPage): Promise<RichResponse> => {
  const closed = await step(adfWindow, cancelItemEvent(page), `Cancel on the item page of ${page.item}`);
  if (showsItemPage(closed) || findShownPopup(closed)) {
    throw ToolError.internal(`Cancel did not close the Oracle Fusion item page of ${page.item}.`);
  }
  return closed;
};

/**
 * Reads the Manage Items results rendered by the search, then opens each chosen row's item
 * page, reads the chosen Relationships sub-tabs and closes the page with Cancel.
 */
export const itemRows: ResultsReader<ItemSearchResults, ItemSearchOptions> = {
  searchDeltas: taskPage => {
    const tableId = findResultsTable(taskPage);
    return tableId ? viewportDeltas(tableId) : undefined;
  },

  read: async ({ adfWindow, taskPage, response, panel, report }, { pick, relationships: kinds = [] }) => {
    const tableId = findResultsTable(taskPage);
    if (!tableId) throw ToolError.internal('The Oracle Fusion Manage Items page has no results table.');
    const table = parseFlatTable(response, tableId);
    if (table.rowCount !== null && table.rows.length !== table.rowCount) {
      throw ToolError.validation(
        `The search matched ${table.rowCount} item rows, but Oracle Fusion returned ${table.rows.length} at once.`,
      );
    }
    const keys = parseRowKeys(response, tableId);
    const rows = recordsOf(table).map((columns, index) => ({ rowKey: keys[index] ?? '', columns }));

    const relationships = new Map<string, ItemRelationships>();
    const chosen = pick?.(rows) ?? [];
    let results = response;
    for (const [index, row] of chosen.entries()) {
      const item = row.columns.Item ?? '';
      const organization = row.columns.Organization ?? '';
      report(`Reading ${item} (${organization}), ${index + 1} of ${chosen.length}`);

      // A closed item page leaves the results as Cancel rendered them; the row links keep their ids.
      const link =
        findItemLink(results, tableId, row.rowKey, item) ?? findItemLink(response, tableId, row.rowKey, item);
      if (!link) throw ToolError.internal(`Oracle Fusion did not show a link for ${item} in the results.`);
      const opened = await step(
        adfWindow,
        openItemEvent(taskPage, tableId, row.rowKey, link, panel.values),
        `opening ${item}`,
      );
      const page = readItemPage(opened, item, organization);

      let read: Awaited<ReturnType<typeof readRelationships>>;
      try {
        read = await readRelationships(adfWindow, page, kinds);
      } catch (error) {
        // The failure is what the caller needs to hear; closing the page is only a courtesy
        // to the window, which is abandoned after a failure anyway.
        await adfWindow.submit(cancelItemEvent(page)).catch(() => undefined);
        throw error;
      }
      relationships.set(row.rowKey, read.relationships);
      results = await cancelItemPage(adfWindow, read.page);
    }
    return { rows, relationships };
  },
};

/**
 * Manage Items, in the Product Information Management work area. One background window
 * serves every tool that searches it. GTIN is not one of the page's criteria until it is
 * added from the Add Fields dialog, under Item Relationships → GTIN.
 */
export const manageItemsScreen = createSearchScreen({
  workArea: productWorkArea,
  workAreaSetting: PRODUCT_WORK_AREA_SETTING_LABEL,
  task: 'Manage Items',
  attributeFields: { GTIN: ['Item Relationships', 'GTIN', 'GTIN'] },
  results: itemRows,
});
