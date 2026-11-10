import { ToolError } from '@opentabs-dev/plugin-sdk';
import { elementText, findRegionAround, type RichResponse, richEvent, VIEWPORT_ROWS } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';
import { findTableIds, parseFlatTable, recordsOf } from './flat-table.js';
import { controlValues } from './row-actions.js';

/**
 * The item page Manage Items opens for a result row, in a tab of the work area's own. It
 * opens ready for editing ("Edit Item: <item> (<organization>)"), so it is only read: its
 * Relationships tab lists the item's GTINs, cross-references and trading partner items, one
 * sub-tab each, and Cancel closes the page with nothing saved. Save is never sent.
 */

/** Title the item page shows: "Edit Item: 4115-NGK (100000)", or "Item: …" when it opens read-only. */
const ITEM_PAGE_TITLE = /^(?:Edit )?Item: (.+) \(([^()]+)\)$/;

/** Event that opens a result row's item page: the row's selection and a click on its item link, in one request, as the browser sends them. */
export const openItemEvent = (
  taskPage: RichResponse,
  tableId: string,
  rowKey: string,
  link: string,
  fields: Record<string, string>,
): RichEvent => ({
  source: link,
  payload: richEvent('action'),
  preceding: [{ source: tableId, payload: richEvent('selection') }],
  fields,
  process: `${tableId},${tableId.slice(0, tableId.lastIndexOf(':'))}`,
  render: findRegionAround(taskPage, tableId) ?? undefined,
  deltas: `{${tableId}={viewportSize=${VIEWPORT_ROWS},selectedRowKeys=${rowKey}}}`,
});

/** Finds the item link of a result row, by the item number it shows. */
export const findItemLink = (response: RichResponse, tableId: string, rowKey: string, item: string): string | null =>
  [...response.document.querySelectorAll(`a[id^="${tableId}:${rowKey}:"]`)].find(link => elementText(link) === item)
    ?.id ?? null;

/** An open item page. */
export interface ItemPage {
  item: string;
  organization: string;
  /** Region of the work area tab the page opened in; the page's commands are processed under it. */
  tab: string;
  /** The Relationships tab of the page. */
  relationshipsTab: string;
  /** Tab set the Relationships tab belongs to. */
  tabSet: string;
  /** Cancel button, which closes the page without saving. */
  cancelButton: string;
  /** Controls of the page, as a browser submits them; the page's values are sent back unchanged. */
  fields: Record<string, string>;
}

/** Finds the tab set a response set up whose element holds the given element. */
const tabSetAround = (response: RichResponse, element: Element): string | null =>
  [...response.scripts.matchAll(/new AdfRichPanelTabbed\('([^']+)'/g)]
    .map(match => match[1] ?? '')
    .find(id => response.document.getElementById(id)?.contains(element)) ?? null;

/**
 * Reads the item page a click on a result row opened. A response showing another item, or a
 * page without its Relationships tab or Cancel button, is an error.
 */
export const readItemPage = (response: RichResponse, item: string, organization: string): ItemPage => {
  const title = [...response.document.querySelectorAll('h1')]
    .map(heading => elementText(heading).match(ITEM_PAGE_TITLE))
    .find(match => match !== null);
  if (!title) throw ToolError.internal(`Oracle Fusion did not open the item page of ${item}.`);
  const [, shownItem = '', shownOrganization = ''] = title;
  if (shownItem.toUpperCase() !== item.toUpperCase() || shownOrganization !== organization) {
    throw ToolError.internal(
      `Oracle Fusion opened item ${shownItem} (${shownOrganization}) instead of ${item} (${organization}).`,
    );
  }

  const tabLink = [...response.document.querySelectorAll('a[id$="::disAcr"]')].find(
    link => elementText(link) === 'Relationships',
  );
  const relationshipsTab = tabLink?.id.slice(0, -'::disAcr'.length);
  const tab = relationshipsTab ? findRegionAround(response, relationshipsTab) : null;
  const tabSet = tabLink ? tabSetAround(response, tabLink) : null;
  const cancelButton = tab
    ? [...response.scripts.matchAll(/new AdfRichCommand(?:Toolbar)?Button\('([^']+)'/g)]
        .map(match => match[1] ?? '')
        .find(id => {
          const button = response.document.getElementById(id);
          return id.startsWith(`${tab}:`) && button !== null && elementText(button) === 'Cancel';
        })
    : undefined;
  if (!(relationshipsTab && tab && tabSet && cancelButton)) {
    throw ToolError.internal(`The Oracle Fusion item page of ${item} has no Relationships tab or Cancel button.`);
  }
  return {
    item: shownItem,
    organization: shownOrganization,
    tab,
    relationshipsTab,
    tabSet,
    cancelButton,
    fields: pageControls(response, tab),
  };
};

/** Controls of the item page a response rendered, as a browser submits them. */
const pageControls = (response: RichResponse, tab: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(controlValues(response.document.documentElement)).filter(([name]) => name.startsWith(`${tab}:`)),
  );

/**
 * The page with the controls a later response rendered, such as those of a sub-tab, added
 * to the ones it is submitted with, as the browser's form gains them.
 */
export const withControlsOf = (page: ItemPage, response: RichResponse): ItemPage => ({
  ...page,
  fields: { ...page.fields, ...pageControls(response, page.tab) },
});

/** Event that shows the page's Relationships tab. */
export const showRelationshipsEvent = (page: ItemPage): RichEvent => ({
  source: page.relationshipsTab,
  payload: richEvent('disclosure', { expand: true }),
  fields: page.fields,
  process: page.tabSet,
});

/** A sub-tab of the Relationships tab, and the headings its table is recognised by. */
interface RelationshipTab {
  label: string;
  headings: readonly string[];
}

/** The sub-tabs of the Relationships tab the plugin reads. */
export const RELATIONSHIP_TABS = {
  gtins: { label: 'GTIN', headings: ['GTIN', 'UOM', 'Party Type'] },
  crossReferences: { label: 'Cross-References', headings: ['Type', 'Value', 'Applicable Organization'] },
  tradingPartnerItems: {
    label: 'Trading Partner Items',
    headings: ['Trading Partner Type', 'Trading Partner Name', 'Trading Partner Item'],
  },
} as const satisfies Record<string, RelationshipTab>;

export type RelationshipKind = keyof typeof RELATIONSHIP_TABS;

/**
 * Finds the link of a Relationships sub-tab, once the Relationships tab shows. The sub-tabs
 * are the links of the tab's navigation pane.
 */
export const findRelationshipLink = (response: RichResponse, page: ItemPage, kind: RelationshipKind): string | null =>
  [...response.scripts.matchAll(/new AdfRichNavigationPane\('([^']+)'/g)]
    .map(match => match[1] ?? '')
    .filter(pane => pane.startsWith(`${page.tab}:`))
    .flatMap(pane => [...response.document.querySelectorAll(`a[id^="${pane}:"]`)])
    .find(link => elementText(link) === RELATIONSHIP_TABS[kind].label)?.id ?? null;

/** Event that shows a Relationships sub-tab. The page's tab is processed and re-rendered with it. */
export const showRelationshipEvent = (page: ItemPage, link: string): RichEvent => ({
  source: link,
  payload: richEvent('action'),
  fields: page.fields,
  process: page.tab,
  render: page.tab,
});

/**
 * Reads the table a Relationships sub-tab shows, one record per row keyed by heading. The
 * table is the one of the page's tab with the sub-tab's headings. A sub-tab showing no such
 * table, or fewer rows than it holds, is an error.
 */
export const parseRelationshipTable = (
  response: RichResponse,
  page: ItemPage,
  kind: RelationshipKind,
): Record<string, string>[] => {
  const { label, headings } = RELATIONSHIP_TABS[kind];
  const table = findTableIds(response)
    .filter(id => id.startsWith(`${page.tab}:`))
    .map(id => parseFlatTable(response, id))
    .find(candidate => headings.every(heading => candidate.headings.includes(heading)));
  if (!table) {
    throw ToolError.internal(
      `The ${label} tab of the Oracle Fusion item page of ${page.item} shows no ${label} table.`,
    );
  }
  if (table.rowCount !== null && table.rows.length < table.rowCount) {
    throw ToolError.internal(
      `The ${label} tab of ${page.item} holds ${table.rowCount} rows, but Oracle Fusion rendered ${table.rows.length}.`,
    );
  }
  return recordsOf(table);
};

/** Event that closes the page with Cancel, discarding nothing since nothing was changed. */
export const cancelItemEvent = (page: ItemPage): RichEvent => ({
  source: page.cancelButton,
  payload: richEvent('action'),
  fields: page.fields,
  process: page.tab,
  render: page.tab,
});

/**
 * Finds a popup a response asked the page to show, such as a question about unsaved
 * changes, or returns null when it showed none. Dialogs the page merely sets up, such as the
 * search panel's Add Fields dialog, are not shown.
 */
export const findShownPopup = (response: RichResponse): string | null =>
  response.scripts.match(/findComponent\('([^']+)'\)\.show\(\)/)?.[1] ?? null;

/** Whether a response still shows an item page, as it does when Cancel did not close it. */
export const showsItemPage = (response: RichResponse): boolean =>
  [...response.document.querySelectorAll('h1')].some(heading => ITEM_PAGE_TITLE.test(elementText(heading)));
