import { ToolError } from '@opentabs-dev/plugin-sdk';
import { type AdfMessage, elementText, type RichResponse, richEvent } from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';
import {
  findTableId,
  pageEvent,
  parseFlatTable,
  parsePageSize,
  parseRowKeys,
  parseTableState,
  recordsOf,
} from './flat-table.js';
import { closeDialogEvent, controlValues, findDialog, type OpenDialog } from './row-actions.js';

/**
 * The lines of a purchase order page and the Lines Actions → Close command. The lines table
 * shows its lines a page at a time: a line is found by paging to it and selected in the
 * single-select table, Close opens the Close Line dialog, and the dialog's OK saves the close.
 */

/** Lines table of an order page: the table of the page's lines toolbar. */
const ORDER_LINES_TABLE = /:AP2:AT1:_ATp:[^:]+$/;

/** The lines table of an order page: its client id and the lines it shows per page. */
export interface LinesTable {
  id: string;
  pageSize: number;
}

/** Finds the lines table an order page set up, with the lines it shows per page. */
export const findOrderLinesTable = (response: RichResponse, order: string): LinesTable => {
  const id = findTableId(response, ORDER_LINES_TABLE);
  if (!id) throw ToolError.internal(`The Oracle Fusion page for ${order} has no lines table.`);
  const pageSize = parsePageSize(response, id);
  if (pageSize === null) {
    throw ToolError.internal(`The Oracle Fusion lines table of ${order} does not show its lines a page at a time.`);
  }
  return { id, pageSize };
};

/** Columns of the lines table that closing a line relies on. */
const REQUIRED_COLUMNS = ['Line', 'Item', 'Quantity', 'Status'] as const;

/** One line of an order as the page lists it. */
export interface OrderLine {
  /**
   * Key of the line's row, which selecting the line names. Fusion hands keys out as pages
   * load and gives them to other lines later, so a key names the line only in the response
   * that rendered it.
   */
  rowKey: string;
  /** Position of the line among the order's lines, from 0, in the order the table lists them. */
  index: number;
  line: number;
  item: string;
  /** Quantity ordered; null when blank. */
  quantity: number | null;
  status: string;
}

/** One page of the lines table as a response rendered it. */
export interface OrderLinesPage {
  lines: OrderLine[];
  /** Position of the page's first row. */
  start: number;
  /** Position just past the page's last row. */
  end: number;
  /**
   * Number of lines the order has; null until Fusion has counted them, which it does once
   * the last page has been shown.
   */
  rowCount: number | null;
  /** Key of the selected row; null when no row is selected. */
  selectedKey: string | null;
}

const quantityOf = (text: string): number | null => {
  const digits = text.replace(/,/g, '').trim();
  if (digits === '') return null;
  const quantity = Number(digits);
  return Number.isFinite(quantity) ? quantity : null;
};

/**
 * Reads the page of an order's lines table a response rendered. The table shows only the
 * columns the user has chosen to show, so one the reading relies on being hidden is an error.
 */
export const parseOrderLines = (response: RichResponse, tableId: string): OrderLinesPage => {
  const table = parseFlatTable(response, tableId);
  const missing = REQUIRED_COLUMNS.filter(column => !table.headings.includes(column));
  if (missing.length > 0) {
    throw ToolError.validation(
      `The order's lines table does not show the ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}. ` +
        'Show it in Fusion (View → Columns on the order page) and try again.',
    );
  }
  const keys = parseRowKeys(response, tableId);
  const { startRow, selectedRowKeys } = parseTableState(response, tableId);
  const lines = recordsOf(table).map((record, position) => ({
    rowKey: keys[position] ?? '',
    index: startRow + position,
    line: Number(record.Line),
    item: record.Item ?? '',
    quantity: quantityOf(record.Quantity ?? ''),
    status: record.Status ?? '',
  }));
  return {
    lines: lines.filter(line => line.rowKey !== '' && Number.isInteger(line.line)),
    start: startRow,
    end: startRow + table.rows.length,
    rowCount: table.rowCount,
    selectedKey: selectedRowKeys[0] ?? null,
  };
};

/**
 * Reads the lines table out of a response that was asked to render it again. A response
 * without the table means the server did not redraw it.
 */
export const parseRenderedOrderLines = (response: RichResponse, tableId: string): OrderLinesPage => {
  if (!response.document.getElementById(`${tableId}::db`)) {
    throw ToolError.internal("Oracle Fusion did not redraw the order's lines.");
  }
  return parseOrderLines(response, tableId);
};

/**
 * Whether a page is the table's last: the order's lines end on it once Fusion has counted
 * them; before that, a page shorter than a full one is the last.
 */
const isLastPage = (page: OrderLinesPage, pageSize: number): boolean =>
  page.rowCount !== null ? page.end >= page.rowCount : page.end - page.start < pageSize;

/** The order's lines found by number, and the first row of the page the table was left on. */
export interface FoundLines {
  lines: Map<number, OrderLine>;
  shownStart: number;
}

/**
 * Reads the order's lines a page at a time, from the page the order opened on, until every
 * wanted line is found or the last page has been read, so a wanted line missing from the
 * result is not on the order.
 */
export const findOrderLines = async (
  adfWindow: AdfWindow,
  table: LinesTable,
  opened: OrderLinesPage,
  wanted: number[],
): Promise<FoundLines> => {
  const lines = new Map<number, OrderLine>();
  let page = opened;
  for (;;) {
    for (const line of page.lines) lines.set(line.line, line);
    if (wanted.every(number => lines.has(number)) || isLastPage(page, table.pageSize)) {
      return { lines, shownStart: page.start };
    }
    const next = parseRenderedOrderLines(
      await adfWindow.submit(pageEvent(table.id, table.pageSize, page.start, page.end)),
      table.id,
    );
    if (next.end <= page.end && !isLastPage(next, table.pageSize)) {
      throw ToolError.internal(`Oracle Fusion did not show the order's lines after the first ${page.end}.`);
    }
    page = next;
  }
};

/** A line selected on the lines table, as the selection's redraw shows it. */
export interface SelectedLine {
  line: OrderLine;
  /** First row of the page the table shows now, which starts at the selected line. */
  shownStart: number;
}

/**
 * Selects a line the order listed: shows the page that starts at the line's position,
 * selects the line there, and checks that Fusion selected that very line. A selection names
 * its row by key, and keys pass to other lines as pages load, so the key is read from the
 * page just shown. Close acts on whichever row is selected, and the order opens with its
 * first line selected, so a selection Fusion did not make is an error.
 */
export const selectLine = async (
  adfWindow: AdfWindow,
  table: LinesTable,
  shownStart: number,
  listed: OrderLine,
): Promise<SelectedLine> => {
  const page = parseRenderedOrderLines(
    await adfWindow.submit(pageEvent(table.id, table.pageSize, shownStart, listed.index)),
    table.id,
  );
  const onPage = page.lines.find(line => line.line === listed.line);
  if (!onPage) throw ToolError.internal(`Line ${listed.line} is no longer where the order listed it.`);

  const selected = parseRenderedOrderLines(await adfWindow.submit(selectLineEvent(table.id, onPage.rowKey)), table.id);
  const line = selected.lines.find(candidate => candidate.rowKey === selected.selectedKey);
  if (line?.line !== listed.line) {
    throw ToolError.internal(
      `Oracle Fusion selected ${line ? `line ${line.line}` : 'no line'} instead of line ${listed.line}.`,
    );
  }
  return { line, shownStart: selected.start };
};

/** A line to close, as the caller named it. */
export interface LineToClose {
  line: number;
  /** Item the line must be for. */
  item: string;
}

/** Quantity receiving still expects of each order line, across the line's schedules, with the line's item. */
export type ExpectedQuantities = Map<number, { item: string; quantity: number }>;

/** Adds up what receiving expects of each order line from its expected shipment rows. */
export const expectedQuantities = (
  rows: { document_line: string; item: string; quantity: number }[],
): ExpectedQuantities => {
  const expected: ExpectedQuantities = new Map();
  for (const row of rows) {
    const line = Number(row.document_line);
    const known = expected.get(line);
    expected.set(line, { item: row.item, quantity: (known?.quantity ?? 0) + row.quantity });
  }
  return expected;
};

const sameItem = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Says why a line must not be closed, or returns null when it may be. A line may be closed
 * only when it is the line and item named, it is Open, and receiving still expects all of
 * its ordered quantity, so nothing has been received against it.
 */
export const refusalFor = (
  wanted: LineToClose,
  found: OrderLine | undefined,
  expected: ExpectedQuantities,
): string | null => {
  if (!found) return `Line ${wanted.line} is not on the order.`;
  if (!sameItem(found.item, wanted.item)) return `Line ${wanted.line} is item ${found.item}, not ${wanted.item}.`;
  if (found.status !== 'Open') return `Line ${wanted.line} is ${found.status}, not Open.`;

  const awaited = expected.get(wanted.line);
  if (!awaited) {
    return `Receiving does not expect line ${wanted.line}: it has been received, or is not receivable in this organization.`;
  }
  if (!sameItem(awaited.item, found.item)) return `Receiving lists line ${wanted.line} as item ${awaited.item}.`;
  if (found.quantity === null) return `Line ${wanted.line} shows no ordered quantity to compare with receiving.`;
  if (awaited.quantity < found.quantity) {
    return (
      `Receiving expects ${awaited.quantity} of the ${found.quantity} ordered on line ${wanted.line}, so part of ` +
      'it has been received.'
    );
  }
  if (awaited.quantity !== found.quantity) {
    return `Receiving expects ${awaited.quantity} on line ${wanted.line}, which orders ${found.quantity}.`;
  }
  return null;
};

/**
 * Event that selects one line of the page shown. The server answers by rendering the lines
 * table again from the selected line on, so the line can be checked as Fusion holds it now.
 */
export const selectLineEvent = (tableId: string, rowKey: string): RichEvent => ({
  source: tableId,
  payload: richEvent('selection'),
  render: tableId,
  deltas: `{${tableId}={selectedRowKeys=${rowKey}}}`,
});

const CLOSE_LINE_COMMAND = ':AT1:_ATp:CA_LINES_CLOSE';

/**
 * Finds the lines toolbar's Close command, or returns null when the page does not offer it.
 * A command the user's role may not run is still rendered, hidden.
 */
export const findCloseLineCommand = (response: RichResponse): string | null => {
  const item = [...response.document.querySelectorAll('[role="menuitem"][id]')].find(candidate =>
    candidate.id.endsWith(CLOSE_LINE_COMMAND),
  );
  if (!item || elementText(item) !== 'Close' || /display:\s*none/.test(item.getAttribute('style') ?? '')) return null;
  return item.id;
};

/** Title of the dialog Close opens. Its popup is shared with other line commands, which retitle it. */
const CLOSE_LINE_TITLE = 'Close Line';

/** The Close Line dialog as the server rendered it. */
export interface CloseLineDialog {
  dialog: OpenDialog;
  /** Every control of the dialog's popup, with the value a browser would submit for it. */
  fields: Record<string, string>;
  /** Form field of the Action dropdown. */
  actionField: string;
  /** Value the Action dropdown submits for each action, keyed by the action's text. */
  actions: Map<string, string>;
  /** Form field of the Reason box. */
  reasonField: string;
}

/** Title a dialog shows in its header; empty when it shows none. */
const dialogTitle = (response: RichResponse, dialog: OpenDialog): string => {
  const title = response.document.getElementById(`${dialog.dialogId}::_ttxt`);
  return title ? elementText(title) : '';
};

/** Form field of the control a dialog labels with `label`. */
const labelledField = (dialog: Element, label: string): Element | null => {
  const target = [...dialog.querySelectorAll('label[for]')].find(candidate => elementText(candidate) === label);
  const control = target ? dialog.ownerDocument.getElementById(target.getAttribute('for') ?? '') : null;
  return control?.hasAttribute('name') ? control : null;
};

/**
 * Reads the Close Line dialog a response to Close opened. Anything else in the response —
 * a message, another dialog, a dialog without the expected controls — is an error naming
 * what Fusion showed instead.
 */
export const readCloseLineDialog = (response: RichResponse): CloseLineDialog => {
  if (response.messages.length > 0) {
    throw ToolError.internal(`Oracle Fusion answered Close with: ${describeMessages(response.messages)}`);
  }
  const dialog = findDialog(response);
  const root = dialog ? response.document.getElementById(dialog.dialogId) : null;
  const content = dialog ? response.document.getElementById(`${dialog.popupId}::content`) : null;
  if (!(dialog && root && content)) throw ToolError.internal('Oracle Fusion opened no dialog for Close.');

  const title = dialogTitle(response, dialog);
  if (title !== CLOSE_LINE_TITLE) {
    throw ToolError.internal(`Oracle Fusion opened "${title}" instead of the ${CLOSE_LINE_TITLE} dialog.`);
  }

  const action = labelledField(root, 'Action');
  const reason = labelledField(root, 'Reason');
  if (!(action instanceof HTMLSelectElement && reason instanceof HTMLTextAreaElement)) {
    throw ToolError.internal(`The Oracle Fusion ${CLOSE_LINE_TITLE} dialog has no Action choice or Reason box.`);
  }
  return {
    dialog,
    fields: controlValues(content),
    actionField: action.name,
    actions: new Map([...action.options].map(option => [elementText(option), option.value])),
    reasonField: reason.name,
  };
};

/**
 * Event that chooses an action in the dialog. The dropdown submits itself as soon as it
 * changes, the dialog staying open.
 */
export const chooseActionEvent = (closing: CloseLineDialog, fields: Record<string, string>): RichEvent => ({
  source: closing.actionField,
  payload: richEvent('valueChange', { autoSubmit: true, suppressMessageShow: 'true' }),
  fields,
  deltas: `{${closing.dialog.popupId}={_shown=${closing.dialog.popupId}}}`,
});

/** Event that answers the dialog with OK, which saves the close. */
export const confirmCloseEvent = (closing: CloseLineDialog, fields: Record<string, string>): RichEvent =>
  closeDialogEvent(closing.dialog, fields);

const describeMessages = (messages: AdfMessage[]): string =>
  messages.map(message => (message.field ? `${message.field}: ${message.text}` : message.text)).join(' ');

/** How Fusion answered a dialog's OK. */
export type CloseAnswer =
  /** Fusion confirmed the save, in its own words. */
  | { saved: true; text: string }
  /** Fusion refused, warned, asked something or said nothing; the text says which. */
  | { saved: false; text: string };

/**
 * Judges Fusion's answer to OK. Only an answer that confirms the save and raises nothing
 * else counts as saved: an error or warning, a further dialog, or silence does not.
 */
export const judgeCloseAnswer = (response: RichResponse, closing: CloseLineDialog): CloseAnswer => {
  const problems = response.messages.filter(
    message => message.severity !== 'info' && message.severity !== 'confirmation',
  );
  if (problems.length > 0) return { saved: false, text: describeMessages(problems) };

  const further = findDialog(response);
  if (further && further.dialogId !== closing.dialog.dialogId) {
    const title = dialogTitle(response, further);
    return { saved: false, text: `Oracle Fusion opened a further dialog${title ? `, "${title}"` : ''}.` };
  }

  if (response.messages.length === 0) return { saved: false, text: 'Oracle Fusion did not confirm the close.' };
  return { saved: true, text: describeMessages(response.messages) };
};
