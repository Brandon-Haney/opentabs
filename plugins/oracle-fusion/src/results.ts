import { ToolError } from '@opentabs-dev/plugin-sdk';
import { type RichResponse, viewportDeltas } from './adf-protocol.js';
import type { AdfWindow } from './adf-window.js';
import {
  clickEvent,
  confirmCloseTabEvent,
  expandSectionEvent,
  fetchPopupEvent,
  findCloseTabWarning,
  findCollapsedSection,
  findDoneButton,
  findPopupButton,
  findRowLink,
  parseDetailFields,
} from './detail-page.js';
import {
  findTableId,
  findTableIds,
  parseFlatTable,
  parseRowKeys,
  recordsOf,
  showAllColumnsEvent,
} from './flat-table.js';
import {
  dismissDialogEvent,
  findDialog,
  findMenuItem,
  menuItemEvent,
  type OpenDialog,
  parseLabelledTable,
  rowKeyOfLink,
  selectRowEvent,
} from './row-actions.js';
import { EXPORT_CONTENT_TYPE, exportEvent, findExportButton, findResultsTable, parseExport } from './search-page.js';
import type { ResultsReader, SearchResults } from './search-screen.js';
import {
  disclosureEvent,
  findTreeTableId,
  inTreeOrder,
  parseTreeRowCount,
  parseTreeRows,
  parseTreeTable,
  type TreeRow,
} from './tree-table.js';

/** Exports of several thousand rows take the server tens of seconds to render. */
const EXPORT_TIMEOUT_MS = 270_000;

/**
 * Reads a flat results table through its Export to Excel button, which returns every
 * matching row in one file, keyed here by column heading.
 */
export const exportedRows: ResultsReader<Record<string, string>[]> = {
  read: async ({ adfWindow, taskPage, panel, report }) => {
    const exportButton = findExportButton(taskPage);
    if (!exportButton) throw ToolError.internal('The Oracle Fusion results table has no Export to Excel button.');

    report('Exporting results');
    const file = await adfWindow.download(exportEvent(panel, exportButton), {
      contentType: EXPORT_CONTENT_TYPE,
      timeout: EXPORT_TIMEOUT_MS,
    });
    return parseExport(file);
  },
};

/** A table command to run on one row: the menu item to click, with the form fields to submit. */
interface RowCommand {
  tableId: string;
  rowKey: string;
  menuItem: string;
  fields: Record<string, string>;
}

/**
 * Runs a table command on one row: selects the row, clicks the menu item, reads the dialog
 * the command opens, and closes it again so the next row starts from the plain results.
 *
 * Some commands open nothing for a row they have nothing to show for, such as View Picks on
 * a line not yet picked; `nothingToShow` gives the value for that case. Without it, or when
 * Fusion answers with a message, a command that opens no dialog is an error.
 */
const readRowDialog = async <T>(
  adfWindow: AdfWindow,
  { tableId, rowKey, menuItem, fields }: RowCommand,
  read: (answer: RichResponse, dialog: OpenDialog) => T,
  nothingToShow?: () => T,
): Promise<T> => {
  await adfWindow.submit(selectRowEvent(tableId, rowKey, fields));
  const answer = await adfWindow.submit(menuItemEvent(menuItem, fields));
  const dialog = findDialog(answer);
  if (!dialog) {
    if (nothingToShow && answer.messages.length === 0) return nothingToShow();
    throw ToolError.internal(`Oracle Fusion opened no dialog for row ${rowKey} of the results.`);
  }
  const value = read(answer, dialog);
  await adfWindow.submit(dismissDialogEvent(answer, dialog, fields));
  return value;
};

const ABOUT_THIS_RECORD = 'About This Record';

/** Which result rows to read further, chosen by the tool once it has seen every row. */
export interface RowDetailOptions {
  /**
   * Returns the link text (typically the record number) of each row whose detail page to
   * read. No row is read when omitted.
   */
  pickRows?: (rows: Record<string, string>[]) => string[];
  /** Also reads the About This Record dialog of each picked row: who created and last updated it. */
  readAudit?: boolean;
  /** Also exports the table of each picked row's detail page, such as an order's lines. */
  exportDetailTable?: boolean;
}

/**
 * Every result row, plus what was read for the picked rows, keyed by link text: the
 * detail-page fields, and the About This Record fields when they were asked for.
 */
export interface RowsWithDetails {
  rows: Record<string, string>[];
  details: Map<string, Record<string, string>>;
  audits: Map<string, Record<string, string>>;
  /** Rows of the dialog the line command opened, for every line of each picked row's detail page. */
  lineDialogs: Map<string, Record<string, string>[]>;
  /** Every row of each picked row's detail page table, through its export, when asked for. */
  detailTables: Map<string, Record<string, string>[]>;
}

/** How the rows chosen for further reading are read. */
interface RowReading {
  /** The results table and its About This Record command, when audits are read. */
  audit: { tableId: string; menuItem: string } | null;
  /** Titles of sections the detail page shows collapsed, expanded and read with it. */
  sections: string[];
  /**
   * Menu command of the detail page's lines table, such as View Picks, run on every line;
   * the table of the dialog it opens is read. None when null.
   */
  lineCommand: string | null;
  /** Whether to export the table of each detail page, such as an order's lines. */
  exportDetailTable: boolean;
}

/** Results table of a detail page: the one in its table toolbar. */
const DETAIL_LINES_TABLE = /:_ATp:[^:]+$/;

/**
 * Runs a detail page's line command on each of its lines and reads the table of the dialog
 * the command opens, with every line's rows in one list.
 */
const readLineDialogs = async (
  adfWindow: AdfWindow,
  detail: RichResponse,
  command: string,
  fields: Record<string, string>,
): Promise<Record<string, string>[]> => {
  const tableId = findTableId(detail, DETAIL_LINES_TABLE);
  const menuItem = findMenuItem(detail, command);
  if (!(tableId && menuItem)) throw ToolError.internal(`The Oracle Fusion detail page has no ${command} command.`);

  const readTable = (answer: RichResponse) => {
    const dialogTable = findTableIds(answer).find(id => id !== tableId);
    return dialogTable ? recordsOf(parseFlatTable(answer, dialogTable)) : [];
  };
  const rows: Record<string, string>[] = [];
  for (const rowKey of parseRowKeys(detail, tableId)) {
    rows.push(...(await readRowDialog(adfWindow, { tableId, rowKey, menuItem, fields }, readTable, () => [])));
  }
  return rows;
};

/**
 * Finds the About This Record command of a results table, for a search that reads audits.
 * Returns null when audits are not read or no row is chosen.
 */
const auditCommandFor = (
  taskPage: RichResponse,
  tableId: string | null,
  readAudit: boolean | undefined,
  chosen: string[],
): RowReading['audit'] => {
  if (!readAudit || chosen.length === 0) return null;
  const menuItem = findMenuItem(taskPage, ABOUT_THIS_RECORD);
  if (!(tableId && menuItem)) {
    throw ToolError.internal(`The Oracle Fusion results table has no ${ABOUT_THIS_RECORD} command.`);
  }
  return { tableId, menuItem };
};

/**
 * Leaves a detail page through its Done button. A page that opened the record in a tab of
 * its own answers Done with the shell's close-tab warning, which is confirmed so the tab
 * closes and the results show again.
 */
const closeDetailPage = async (adfWindow: AdfWindow, done: string): Promise<RichResponse> => {
  const left = await adfWindow.submit(clickEvent(done));
  const warning = findCloseTabWarning(left);
  if (!warning) return left;
  const shown = await adfWindow.submit(fetchPopupEvent(warning));
  const confirm = findPopupButton(shown, 'Yes');
  if (!confirm) throw ToolError.internal('The Oracle Fusion close-tab warning has no Yes button.');
  return adfWindow.submit(confirmCloseTabEvent(warning, confirm));
};

/**
 * Reads chosen result rows one at a time: the About This Record dialog when asked for, then
 * the detail page with any collapsed sections asked for, returning to the results after
 * each. Rows are named by the text of their link, typically the record number.
 */
const readChosenRows = async (
  { adfWindow, response, panel, report }: SearchResults,
  chosen: string[],
  reading: RowReading,
): Promise<Omit<RowsWithDetails, 'rows'>> => {
  const details = new Map<string, Record<string, string>>();
  const audits = new Map<string, Record<string, string>>();
  const lineDialogs = new Map<string, Record<string, string>[]>();
  const detailTables = new Map<string, Record<string, string>[]>();
  let page = response;
  for (const [index, linkText] of chosen.entries()) {
    report(`Reading details ${index + 1} of ${chosen.length}`);
    // A page that opens records in tabs of their own answers Done without redrawing the
    // results, so a row's link is then found in the results as the search rendered them.
    const link = findRowLink(page, linkText) ?? findRowLink(response, linkText);
    const rowKey = link ? rowKeyOfLink(link) : null;
    if (!(link && rowKey)) {
      throw ToolError.internal(`Oracle Fusion did not show a link for row ${linkText} in the results.`);
    }

    if (reading.audit) {
      const command = { ...reading.audit, rowKey, fields: panel.values };
      audits.set(linkText, await readRowDialog(adfWindow, command, parseDetailFields));
    }

    // Some tables open the selected row rather than the row whose link was clicked, so the
    // click carries the row's selection, as a browser's click does.
    const table = link.slice(0, link.lastIndexOf(`:${rowKey}:`));
    const detail = await adfWindow.submit({
      ...clickEvent(link, panel.values),
      deltas: `{${table}={selectedRowKeys=${rowKey}}}`,
    });
    let fields = parseDetailFields(detail);
    for (const title of reading.sections) {
      const section = findCollapsedSection(detail, title);
      if (!section) continue;
      fields = { ...fields, ...parseDetailFields(await adfWindow.submit(expandSectionEvent(section))) };
    }
    details.set(linkText, fields);
    if (reading.lineCommand) {
      lineDialogs.set(linkText, await readLineDialogs(adfWindow, detail, reading.lineCommand, panel.values));
    }
    if (reading.exportDetailTable) {
      const exportButton = findExportButton(detail);
      if (!exportButton)
        throw ToolError.internal(`The Oracle Fusion detail page for ${linkText} has no Export button.`);
      const file = await adfWindow.download(clickEvent(exportButton), {
        contentType: EXPORT_CONTENT_TYPE,
        timeout: EXPORT_TIMEOUT_MS,
      });
      detailTables.set(linkText, parseExport(file));
    }

    const done = findDoneButton(detail);
    if (!done) throw ToolError.internal(`The Oracle Fusion detail page for ${linkText} has no Done button.`);
    page = await closeDetailPage(adfWindow, done);
  }
  return { details, audits, lineDialogs, detailTables };
};

/**
 * Reads a results table through its export, then reads chosen rows one at a time. When rows
 * will be read, the search asks for every row to be rendered, so each chosen row's link is
 * on the page however long the result is.
 */
export const exportedRowsWithDetails: ResultsReader<RowsWithDetails, RowDetailOptions> = {
  searchDeltas: (taskPage, { pickRows }) => {
    const tableId = pickRows ? findResultsTable(taskPage) : null;
    return tableId ? viewportDeltas(tableId) : undefined;
  },

  read: async (results, { pickRows, readAudit, exportDetailTable = false }) => {
    const rows = await exportedRows.read(results);
    const chosen = pickRows?.(rows) ?? [];
    const audit = auditCommandFor(results.taskPage, findResultsTable(results.taskPage), readAudit, chosen);
    const reading = { audit, sections: [], lineCommand: null, exportDetailTable };
    return { rows, ...(await readChosenRows(results, chosen, reading)) };
  },
};

/**
 * Every row of a tree table, outermost rows first, each followed by its descendants, and
 * the availability read for chosen rows.
 */
export interface TreeResults {
  /** Headings of the value columns, in the order each row's `cells` follows. */
  columns: string[];
  rows: TreeRow[];
  /**
   * Item Availability dialog of each row it was read for, keyed by row key: each quantity
   * type (Total, Available to Transact, Available to Reserve) with its values by heading.
   */
  availability: Map<string, Record<string, Record<string, string>>>;
}

/** Which tree rows to read further, chosen by the tool once it has seen every row. */
export interface TreeOptions {
  /** Returns the key of each row whose Item Availability dialog to read. No row is read when omitted. */
  pickAvailabilityRows?: (rows: TreeRow[]) => string[];
}

const VIEW_ITEM_AVAILABILITY = 'View Item Availability';

/** Numbers the fetches this adapter has made, the way the ADF client numbers its own. */
let fetchCount = 0;

/**
 * Reads a tree table by expanding it one level at a time until no row has unloaded
 * children, then reads the Item Availability dialog of each chosen row. All rows of a
 * level are expanded in a single request.
 *
 * Expansion state belongs to the user's Fusion session, so rows expanded here also show
 * expanded the next time the user runs the same search.
 */
export const treeRows: ResultsReader<TreeResults, TreeOptions> = {
  searchDeltas: taskPage => {
    const tableId = findTreeTableId(taskPage);
    return tableId ? viewportDeltas(tableId) : undefined;
  },

  read: async ({ adfWindow, taskPage, response, panel, report }, { pickAvailabilityRows }) => {
    const table = parseTreeTable(response);
    if (!table) throw ToolError.internal('The Oracle Fusion search returned no results tree.');

    const rows = [...table.rows];
    const disclosed = new Set(table.disclosedKeys);
    let rowCount = table.rowCount;

    let collapsed = rows.filter(row => row.expandable && !disclosed.has(row.key));
    while (collapsed.length > 0) {
      report(`Expanding ${collapsed.length} rows`);
      for (const row of collapsed) disclosed.add(row.key);

      const expanded = await adfWindow.submit(disclosureEvent(table.id, [...disclosed], fetchCount++, panel.values));
      const children = parseTreeRows(expanded);
      rows.push(...children);
      rowCount = parseTreeRowCount(expanded) ?? rowCount;
      collapsed = children.filter(row => row.expandable && !disclosed.has(row.key));
    }

    if (rowCount !== null && rows.length !== rowCount) {
      throw ToolError.internal(`Oracle Fusion holds ${rowCount} result rows but returned ${rows.length} of them.`);
    }

    const ordered = inTreeOrder(rows);
    const chosen = pickAvailabilityRows?.(ordered) ?? [];
    const availability = new Map<string, Record<string, Record<string, string>>>();
    if (chosen.length > 0) {
      const menuItem = findMenuItem(taskPage, VIEW_ITEM_AVAILABILITY);
      if (!menuItem) {
        throw ToolError.internal(`The Oracle Fusion results table has no ${VIEW_ITEM_AVAILABILITY} command.`);
      }
      for (const [index, rowKey] of chosen.entries()) {
        report(`Reading availability ${index + 1} of ${chosen.length}`);
        const command = { tableId: table.id, rowKey, menuItem, fields: panel.values };
        availability.set(rowKey, await readRowDialog(adfWindow, command, parseLabelledTable));
      }
    }

    return { columns: table.columns, rows: ordered, availability };
  },
};

/** How rendered rows are read. */
interface RenderedRowsOptions {
  /**
   * Shows every column the table hides by default before the first search, so the rows
   * carry them. Fusion keeps the choice beyond the window that made it: the user's own
   * view of the table shows every column too, as after View → Columns → Show All.
   */
  showAllColumns?: boolean;
}

/**
 * Reads a results table that has no Export to Excel button from the search response itself.
 * The search asks for every row to be rendered at once. `tablePattern` picks the results
 * table among the tables the search page sets up.
 */
export const renderedRows = (
  tablePattern: RegExp,
  { showAllColumns = false }: RenderedRowsOptions = {},
): ResultsReader<Record<string, string>[]> => ({
  searchDeltas: taskPage => {
    const tableId = findTableId(taskPage, tablePattern);
    return tableId ? viewportDeltas(tableId) : undefined;
  },

  prepare: async ({ adfWindow, taskPage, panel }) => {
    if (!showAllColumns) return;
    const tableId = findTableId(taskPage, tablePattern);
    const showAll = tableId ? showAllColumnsEvent(taskPage, tableId) : null;
    if (showAll) await adfWindow.submit({ ...showAll, fields: panel.values });
  },

  read: async ({ taskPage, response }) => {
    const tableId = findTableId(taskPage, tablePattern);
    if (!tableId) throw ToolError.internal('The Oracle Fusion search page has no results table.');
    const table = parseFlatTable(response, tableId);
    // Fusion renders at most a few hundred rows of a table in one response, however many
    // are asked for, so a larger result cannot be read whole.
    if (table.rowCount !== null && table.rows.length < table.rowCount) {
      throw ToolError.validation(
        `The search matched ${table.rowCount} rows, but Oracle Fusion returns at most ${table.rows.length} at ` +
          'once. Narrow the search (add an item, subinventory or status) and search again.',
      );
    }
    if (table.rowCount !== null && table.rows.length !== table.rowCount) {
      throw ToolError.internal(
        `Oracle Fusion holds ${table.rowCount} result rows but returned ${table.rows.length} of them.`,
      );
    }
    return recordsOf(table);
  },
});

/** How rendered rows and their detail pages are read. */
interface RenderedRowsWithDetailsOptions extends RenderedRowsOptions {
  /** Titles of sections each detail page shows collapsed, expanded and read with it. */
  sections?: string[];
  /** Menu command of each detail page's lines table to run on every line, such as View Picks. */
  lineCommand?: string;
}

/**
 * Reads a results table from the search response, as `renderedRows` does, then reads chosen
 * rows one at a time as `exportedRowsWithDetails` does.
 */
export const renderedRowsWithDetails = (
  tablePattern: RegExp,
  { sections = [], lineCommand, ...options }: RenderedRowsWithDetailsOptions = {},
): ResultsReader<RowsWithDetails, RowDetailOptions> => {
  const table = renderedRows(tablePattern, options);
  return {
    searchDeltas: taskPage => table.searchDeltas?.(taskPage),
    prepare: page => table.prepare?.(page) ?? Promise.resolve(),
    read: async (results, { pickRows, readAudit, exportDetailTable = false }) => {
      const rows = await table.read(results);
      const chosen = pickRows?.(rows) ?? [];
      const audit = auditCommandFor(results.taskPage, findTableId(results.taskPage, tablePattern), readAudit, chosen);
      return {
        rows,
        ...(await readChosenRows(results, chosen, {
          audit,
          sections,
          lineCommand: lineCommand ?? null,
          exportDetailTable,
        })),
      };
    },
  };
};
