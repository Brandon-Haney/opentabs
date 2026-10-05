import { elementText, type RichResponse, richEventBatch, VIEWPORT_ROWS } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';

/**
 * An ADF tree table: results shown as nested rows that load their children when expanded.
 *
 * Rows arrive as HTML. Each carries a row key, the keys of its ancestors, and its values
 * in an inner table whose cells follow the order of the column headings.
 */

/** One row of a tree table. */
export interface TreeRow {
  key: string;
  /** Keys of the rows above this one, outermost first. */
  ancestors: string[];
  /** Text of the node column, e.g. a level name followed by a value. */
  label: string;
  /** Whether the row has a control to show child rows. */
  expandable: boolean;
  /** Values of the remaining columns, in heading order. */
  cells: string[];
}

/** A tree table as a search rendered it. */
export interface TreeTable {
  id: string;
  /** Headings of the value columns, in the order `TreeRow.cells` follows. */
  columns: string[];
  rows: TreeRow[];
  /** Number of rows the server holds for the table, or null when it did not say. */
  rowCount: number | null;
  /**
   * Keys of every row the server treats as expanded. The set belongs to the user's session,
   * not to one window, so it includes rows expanded in other windows.
   */
  disclosedKeys: string[];
}

/**
 * The node cell of a tree row: the cell that shows the row's level and value. Only tree
 * rows have one, which tells them apart from the rows of other tables a response renders,
 * such as a dialog's table left open on the page.
 */
const NODE_CELL = ':scope > td[_afrndcol]';

/** Reads every tree row a response rendered. */
export const parseTreeRows = (response: RichResponse): TreeRow[] =>
  [...response.document.querySelectorAll('tr[_afrrk]')].flatMap(row => {
    const node = row.querySelector(NODE_CELL);
    if (!node) return [];
    return {
      key: row.getAttribute('_afrrk') ?? '',
      ancestors: (row.getAttribute('_afrap') ?? '').split('_').filter(Boolean),
      label: elementText(node),
      expandable: node.querySelector('[_afrdisimg]') != null,
      cells: [...row.querySelectorAll('table[_afrit] td')].map(elementText),
    };
  });

/** Reads the row count a response states for its tree rows, or null when it states none. */
export const parseTreeRowCount = (response: RichResponse): number | null => {
  const count = [...response.document.querySelectorAll('table[_rowcount]')]
    .find(table => table.querySelector('tr[_afrrk] > td[_afrndcol]'))
    ?.getAttribute('_rowcount');
  return count == null || Number(count) < 0 ? null : Number(count);
};

/** Finds the client id of the tree table a response set up, or null when it set up none. */
export const findTreeTableId = (response: RichResponse): string | null =>
  response.scripts.match(/new AdfRichTreeTable\('([^']+)'/)?.[1] ?? null;

/**
 * Orders rows as the tree shows them: each row followed by its descendants, with siblings
 * in the order they arrived. Rows arrive level by level, so children are not adjacent to
 * their parents until sorted.
 */
export const inTreeOrder = (rows: TreeRow[]): TreeRow[] => {
  const children = new Map<string, TreeRow[]>();
  for (const row of rows) {
    const parent = row.ancestors.at(-1) ?? '';
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const descend = (parent: string): TreeRow[] =>
    (children.get(parent) ?? []).flatMap(row => [row, ...descend(row.key)]);
  return descend('');
};

/**
 * Reads the tree table out of the response to a search, or returns null when the response
 * has none. The table's headings carry ids under the table's own; other tables on the
 * page, such as a dialog left open, have headings of their own. The first heading belongs
 * to the node column; headings that span several columns are group captions rather than
 * columns.
 */
export const parseTreeTable = (response: RichResponse): TreeTable | null => {
  const setup = response.scripts.match(/new AdfRichTreeTable\('([^']+)',\{[\s\S]*?'disclosedRowKeys':\{([^}]*)\}/);
  const id = setup?.[1];
  if (!id) return null;

  const headings = [...response.document.querySelectorAll('th[id]')]
    .filter(heading => heading.id.startsWith(`${id}:`) && Number(heading.getAttribute('colspan') ?? 1) === 1)
    .map(elementText)
    .filter(heading => heading !== '');

  return {
    id,
    columns: headings.slice(1),
    rows: parseTreeRows(response),
    rowCount: parseTreeRowCount(response),
    disclosedKeys: [...(setup[2] ?? '').matchAll(/'([^']+)':true/g)].map(match => match[1] ?? ''),
  };
};

/**
 * Event that expands rows and fetches their children.
 *
 * The rows to expand are not named in the event: the client sends the full set of expanded
 * row keys as component state and the server expands whichever are new. The accompanying
 * fetch is what makes the server return the inserted rows. `fetchId` numbers the fetches a
 * window has made.
 */
export const disclosureEvent = (
  tableId: string,
  disclosedKeys: string[],
  fetchId: number,
  fields: Record<string, string>,
): RichEvent => ({
  source: tableId,
  payload: richEventBatch([['rowDisclosure'], ['fetch', { id: fetchId, subtype: 5, suppressMessageClear: 'true' }]]),
  fields,
  process: `${tableId},${tableId}`,
  deltas: `{${tableId}={viewportSize=${VIEWPORT_ROWS},disclosedRowKeys=${disclosedKeys.join('$afr$')}}}`,
});
