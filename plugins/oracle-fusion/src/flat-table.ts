import { elementText, type RichResponse, richEvent, VIEWPORT_ROWS } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';

/**
 * A plain ADF table as a response rendered it: column headings, then one row per record.
 *
 * Each row holds a row-header cell, a cell for each frozen column, and an inner table whose
 * cells hold the remaining columns; together they follow the order of the column headings.
 * A table whose rows expand to show more detail also has an untitled disclosure cell ahead
 * of the values. A cell can itself hold a table (a link beside a notes icon), so the values
 * are the inner table's own cells, not every cell inside it.
 */

/** A table rendered in a response: its headings and each row's values in heading order. */
export interface FlatTable {
  /** One heading per value column; a column without a title, such as an icon column, has an empty heading. */
  headings: string[];
  rows: string[][];
  /** Number of rows the server holds for the table, or null when it did not say. */
  rowCount: number | null;
}

/** Reads the client ids of the tables a response set up, in order. */
export const findTableIds = (response: RichResponse): string[] =>
  [...response.scripts.matchAll(/new AdfRichTable\('([^']+)'/g)].map(match => match[1] ?? '');

/** Reads the client id of the first table a response set up whose id matches the pattern. */
export const findTableId = (response: RichResponse, pattern: RegExp): string | null =>
  findTableIds(response).find(id => pattern.test(id)) ?? null;

/**
 * Values one cell of a row contributes, in column order. Frozen columns are cells of the
 * row itself; the other columns sit in one cell as an inner table; the row-header cell and
 * the disclosure cell of an expandable row hold no value and have no heading.
 */
const rowValues = (cell: HTMLTableCellElement): string[] => {
  if (cell.hasAttribute('_afrrh') || cell.hasAttribute('_afrdetcol')) return [];
  const inner = cell.querySelector<HTMLTableElement>('table[_afrit]');
  if (inner) return [...(inner.rows[0]?.cells ?? [])].map(elementText);
  return [elementText(cell)];
};

/**
 * Reads a table's headings and rows out of a response. Headings are the table's own (their
 * ids sit under the table's id) and name a single column. The row-header column, marked like
 * its cells, holds no value and is left out; an untitled value column, such as an icon
 * column, keeps its place so the values after it stay under their own headings.
 */
export const parseFlatTable = (response: RichResponse, tableId: string): FlatTable => {
  const headings = [...response.document.querySelectorAll('th[id]')]
    .filter(
      heading =>
        heading.id.startsWith(`${tableId}:`) &&
        Number(heading.getAttribute('colspan') ?? 1) === 1 &&
        !heading.hasAttribute('_afrrh'),
    )
    .map(elementText);

  const body = response.document.getElementById(`${tableId}::db`);
  const rows = [...(body?.querySelectorAll<HTMLTableRowElement>('tr[_afrrk]') ?? [])].map(row =>
    [...row.cells].flatMap(rowValues),
  );

  const count = body?.querySelector('table[_rowcount]')?.getAttribute('_rowcount');
  const rowCount = count == null || Number(count) < 0 ? null : Number(count);
  return { headings, rows, rowCount };
};

/**
 * Whether a response rendered every row of a table: the server counted the rows and rendered
 * as many. A table that renders only its first rows leaves the count unknown.
 */
export const rendersEveryRow = (table: FlatTable): boolean =>
  table.rowCount !== null && table.rows.length === table.rowCount;

/** Where a response's rows of a table sit among all its rows, and which rows are selected. */
export interface TableState {
  /** Position of the first rendered row among all the table's rows, from 0. */
  startRow: number;
  /** Keys of the selected rows. */
  selectedRowKeys: string[];
}

/**
 * Reads a table's state from the attributes of its rendered body: `_startRow`, and
 * `_selState`, which maps each selected row's key to 1 (`{'13':1}`).
 */
export const parseTableState = (response: RichResponse, tableId: string): TableState => {
  const body = response.document.getElementById(`${tableId}::db`)?.querySelector('table[_rowcount]');
  const startRow = Number(body?.getAttribute('_startrow'));
  const selection = body?.getAttribute('_selstate') ?? '';
  return {
    startRow: Number.isInteger(startRow) && startRow >= 0 ? startRow : 0,
    selectedRowKeys: [...selection.matchAll(/'([^']*)':1/g)].map(match => match[1] ?? ''),
  };
};

/**
 * Rows per page of a table that shows its rows a page at a time (`scrollPolicy` page, with
 * a navigation bar beneath it), read from the table's set-up script. Null when the response
 * did not set the table up or the table scrolls instead. Such a table renders one page per
 * response, however large a viewport is asked for.
 */
export const parsePageSize = (response: RichResponse, tableId: string): number | null => {
  const start = response.scripts.indexOf(`new AdfRichTable('${tableId}',{`);
  const end = start < 0 ? -1 : response.scripts.indexOf('}', start);
  if (end < 0) return null;
  const setup = response.scripts.slice(start, end);
  if (!setup.includes("'scrollPolicy':'page'")) return null;
  const rows = Number(setup.match(/'rows':(\d+)/)?.[1]);
  return Number.isInteger(rows) && rows > 0 ? rows : null;
};

/**
 * Event that shows the page of a paged table starting at row `start`, as the table's
 * navigation bar does; the server answers by rendering the table again. A start past the
 * last page shows the last full page. `shownStart` is the first row of the page shown now.
 */
export const pageEvent = (tableId: string, pageSize: number, shownStart: number, start: number): RichEvent => ({
  source: tableId,
  payload: richEvent('rangeChange', {
    oldStart: String(shownStart),
    oldEnd: String(shownStart + pageSize - 1),
    newStart: String(start),
    newEnd: String(start + pageSize - 1),
  }),
  render: tableId,
});

/**
 * Event that has the server render every row of a scrolling table, which renders only its
 * first rows when its page opens: the row already selected is selected again, which changes
 * nothing, with a viewport long enough for every row.
 */
export const everyRowEvent = (tableId: string, selectedKey: string, fields: Record<string, string>): RichEvent => ({
  source: tableId,
  payload: richEvent('selection'),
  fields,
  render: tableId,
  deltas: `{${tableId}={selectedRowKeys=${selectedKey},viewportSize=${VIEWPORT_ROWS}}}`,
});

/** Keys each row's values by the heading of its column, leaving out untitled columns. */
export const recordsOf = (table: FlatTable): Record<string, string>[] =>
  table.rows.map(cells =>
    Object.fromEntries(
      table.headings.flatMap((heading, index) => (heading === '' ? [] : [[heading, cells[index] ?? '']])),
    ),
  );

/** Panel collection a table sits in: the toolbar, menus and column choices around it. */
const collectionOf = (tableId: string): string => tableId.slice(0, tableId.lastIndexOf(':'));

/** Checkbox items of a table's View → Columns menus, one per column and menu. */
const columnToggles = (response: RichResponse, tableId: string): Element[] =>
  [...response.document.querySelectorAll('[role="menuitemcheckbox"][id]')].filter(
    item => item.id.startsWith(`${collectionOf(tableId)}:`) && item.id.includes('_shwClm'),
  );

/**
 * Event that shows every column of a table, as View → Columns → Show All does, or null
 * when every column already shows. The menu items of the hidden columns are sent as ticked,
 * and every column item is re-rendered.
 */
export const showAllColumnsEvent = (response: RichResponse, tableId: string): RichEvent | null => {
  const toggles = columnToggles(response, tableId);
  const hidden = toggles.filter(item => item.getAttribute('aria-checked') !== 'true');
  if (hidden.length === 0) return null;
  return {
    source: tableId,
    payload: richEvent('showColumns', { showType: 'showAll' }),
    render: [`${collectionOf(tableId)}:_clmCxt`, ...toggles.map(item => item.id)].join(','),
    deltas: `{${hidden.map(item => `${item.id}={selected=true}`).join(',')}}`,
  };
};

/** Reads the key of each row a response rendered of a table, in order. */
export const parseRowKeys = (response: RichResponse, tableId: string): string[] =>
  [...(response.document.getElementById(`${tableId}::db`)?.querySelectorAll('tr[_afrrk]') ?? [])].map(
    row => row.getAttribute('_afrrk') ?? '',
  );
