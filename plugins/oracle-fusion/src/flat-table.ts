import { elementText, type RichResponse, richEvent } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';

/**
 * A plain ADF table as a response rendered it: column headings, then one row per record.
 *
 * Each row holds a row-header cell, a cell for each frozen column, and an inner table whose
 * cells hold the remaining columns; together they follow the order of the column headings.
 * A cell can itself hold a table (a link beside a notes icon), so the values are the inner
 * table's own cells, not every cell inside it.
 */

/** A table rendered in a response: its headings and each row's values in heading order. */
export interface FlatTable {
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
 * row itself; the other columns sit in one cell as an inner table; the row-header cell
 * holds no value.
 */
const rowValues = (cell: HTMLTableCellElement): string[] => {
  if (cell.hasAttribute('_afrrh')) return [];
  const inner = cell.querySelector<HTMLTableElement>('table[_afrit]');
  if (inner) return [...(inner.rows[0]?.cells ?? [])].map(elementText);
  return [elementText(cell)];
};

/**
 * Reads a table's headings and rows out of a response. Headings are the table's own (their
 * ids sit under the table's id) and name a single column; the row-header column has no text.
 */
export const parseFlatTable = (response: RichResponse, tableId: string): FlatTable => {
  const headings = [...response.document.querySelectorAll('th[id]')]
    .filter(heading => heading.id.startsWith(`${tableId}:`) && Number(heading.getAttribute('colspan') ?? 1) === 1)
    .map(elementText)
    .filter(heading => heading !== '');

  const body = response.document.getElementById(`${tableId}::db`);
  const rows = [...(body?.querySelectorAll<HTMLTableRowElement>('tr[_afrrk]') ?? [])].map(row =>
    [...row.cells].flatMap(rowValues),
  );

  const count = body?.querySelector('table[_rowcount]')?.getAttribute('_rowcount');
  const rowCount = count == null || Number(count) < 0 ? null : Number(count);
  return { headings, rows, rowCount };
};

/** Keys each row's values by the heading of its column. */
export const recordsOf = (table: FlatTable): Record<string, string>[] =>
  table.rows.map(cells => Object.fromEntries(table.headings.map((heading, index) => [heading, cells[index] ?? ''])));

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
